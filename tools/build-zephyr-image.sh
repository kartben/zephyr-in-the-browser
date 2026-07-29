#!/usr/bin/env bash
#
# Build the packaged Zephyr samples for the browser and install unstripped ELFs
# into public/qemu/zephyr/, where the qemu backend fetches them at runtime.
#
# Images stay unstripped so the in-page debugger can resolve
# CONFIG_DEBUG_THREAD_INFO plus CONFIG_OBJ_CORE symbols (_kernel,
# z_obj_type_list, the object-core descriptor bounds, …). Drop-in custom ELFs
# should likewise keep symbols for the Threads and Kernel Objects tabs.
#
#   tools/build-zephyr-image.sh [board|all] [app|all]
#     board  a board from tools/samples.manifest, or "all" (the default)
#     app    an app id from the manifest (or a <id>_trace twin), or "all"
#
# So a bare `tools/build-zephyr-image.sh` rebuilds every packaged sample for
# every board. The board/app list lives in tools/samples.manifest — adding a
# sample is one manifest line plus its entry in src/boards.ts, then a rerun.
# On qemu_cortex_a53 each entry also yields a <id>_trace twin (browser-tracing
# snippet) unless the sample already embeds CTF in its own prj.conf — see
# docs/focus.md.
#
# Images land at public/qemu/zephyr/<board>/<app>.elf, named after the *program*
# rather than the board — several apps run on one board, so a board-named file
# said nothing about what would actually boot.
#
# Every build applies the browser_bridge shield (zephyr-module/boards/shields/),
# which adds the browser-fed peripherals — GNSS UART, host sensor with its
# accel0/temp0/... aliases, host GPIO, host audio out (I2S), host mic (DMIC),
# browser-sized ramfb — to the plain QEMU boards.
#
# Environment overrides:
#   ZEPHYR_WS      west workspace   (default: ~/zephyrproject)
#   ZEPHYR_IMAGE   container image  (default: ghcr.io/zephyrproject-rtos/zephyr-build:main)
#   ZEPHYR_NATIVE  if non-empty, run west and the SDK tools directly instead of
#                  in the container. Default when `west` is on PATH and ZEPHYR_WS
#                  looks like a west workspace — preferred for local machines so
#                  several apps can build in parallel without Docker overhead.
#   ZEPHYR_DOCKER  if non-empty, force the container path even when native would
#                  work (CI that wants Docker, or a broken local SDK).
#   JOBS           max parallel builds (default: nproc on native, 1 in Docker —
#                  each Docker invocation is already a full container; stacking
#                  them thrashes disk. Native is the parallel path.)
#
# In container mode this needs no local Zephyr toolchain — everything runs in
# the container. Build directories are per-app, so independent invocations can
# run concurrently either way.
#
# To ship the result, run tools/release.sh images — it packages these into their
# own release asset, separate from the emulator's, and points IMAGES_RELEASE at
# it, so shipping new guests needs no QEMU rebuild (docs/deploying.md).

set -euo pipefail

BOARD_FILTER="${1:-all}"
APP_FILTER="${2:-all}"

ZEPHYR_WS="${ZEPHYR_WS:-$HOME/zephyrproject}"
ZEPHYR_IMAGE="${ZEPHYR_IMAGE:-ghcr.io/zephyrproject-rtos/zephyr-build:main}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/tools/samples.manifest"
SHIELD=browser_bridge

# Samples whose own prj.conf already enables CTF + semihost — no _trace twin.
BUILTIN_TRACE_IDS='tracing tracing_pipeline'

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[ -d "$ZEPHYR_WS/zephyr" ] || {
  echo "No Zephyr tree at $ZEPHYR_WS/zephyr — set ZEPHYR_WS to your west workspace." >&2
  exit 1
}

# Prefer a local west + SDK on the developer's machine. Docker remains available
# via ZEPHYR_DOCKER=1, and CI that prepares a workspace sets ZEPHYR_NATIVE=1.
if [ -n "${ZEPHYR_DOCKER:-}" ]; then
  ZEPHYR_NATIVE=""
elif [ -z "${ZEPHYR_NATIVE:-}" ]; then
  if command -v west >/dev/null 2>&1; then
    ZEPHYR_NATIVE=1
    log "Using local Zephyr at $ZEPHYR_WS (set ZEPHYR_DOCKER=1 to force Docker)"
  else
    log "west not on PATH — falling back to Docker ($ZEPHYR_IMAGE)"
  fi
fi

if [ -n "${ZEPHYR_NATIVE:-}" ]; then
  JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
else
  JOBS="${JOBS:-1}"
fi

# Manifest lines, comments and blanks stripped.
ENTRIES="$(grep -Ev '^[[:space:]]*(#|$)' "$MANIFEST")"

known_boards() { echo "$ENTRIES" | cut -d: -f1 | sort -u | tr '\n' ' '; }
known_apps()   { echo "$ENTRIES" | awk -F: -v b="$1" '$1 == b {print $2}' | tr '\n' ' '; }

is_builtin_trace() {
  case " $BUILTIN_TRACE_IDS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Expand each qemu_cortex_a53 row into a <id>_trace twin (browser-tracing snippet).
# Keep in lockstep with withA53TraceVariants() in src/boards.ts.
expand_trace_variants() {
  local board id sample confs snippets t_snippets
  while IFS=: read -r board id sample confs snippets; do
    printf '%s:%s:%s:%s:%s\n' "$board" "$id" "$sample" "${confs:-}" "${snippets:-}"
    [ "$board" = "qemu_cortex_a53" ] || continue
    is_builtin_trace "$id" && continue
    case "$id" in *_trace) continue ;; esac
    case ",${confs:-}," in *,conf/tracing.conf,*|*,conf/tracing-net.conf,*) continue ;; esac

    t_snippets="${snippets:-}"
    if [ -n "$t_snippets" ]; then
      t_snippets="$t_snippets,browser-tracing"
    else
      t_snippets="browser-tracing"
    fi
    case ",${confs:-}," in
      *,conf/net.conf,*) t_snippets="$t_snippets,browser-tracing-net" ;;
    esac
    printf '%s:%s_trace:%s:%s:%s\n' "$board" "$id" "$sample" "${confs:-}" "$t_snippets"
  done
}

EXPANDED="$(echo "$ENTRIES" | expand_trace_variants)"

if [ "$BOARD_FILTER" != "all" ] && ! echo "$EXPANDED" | grep -q "^$BOARD_FILTER:"; then
  echo "Unknown board '$BOARD_FILTER'. Known: $(known_boards)" >&2
  exit 1
fi

SELECTED="$(echo "$EXPANDED" | awk -F: -v b="$BOARD_FILTER" -v a="$APP_FILTER" \
  '(b == "all" || $1 == b) && (a == "all" || $2 == a || $2 == a "_trace")')"
[ -n "$SELECTED" ] || {
  echo "Unknown app '$APP_FILTER' for board '$BOARD_FILTER'." >&2
  echo "Known base apps for $BOARD_FILTER: $(known_apps "$BOARD_FILTER")" >&2
  echo "(A53 also accepts <app>_trace twins — see docs/focus.md.)" >&2
  exit 1
}

# This repo ships an out-of-tree Zephyr module: the qemu,host-{gpio,audio,mic}
# and virtio drivers with their bindings, plus the browser_bridge shield the
# module's board_root exposes and the snippets its snippet_root exposes.
# Everything is passed as CMake args;
# note that current Zephyr *rejects* -DCONFIG_* on the command line, so Kconfig
# tweaks travel in .conf fragments listed per app in the manifest / snippets.
#
# The path depends on the mode: the container sees this repo mounted at /repo,
# a native build uses it in place.
if [ -n "${ZEPHYR_NATIVE:-}" ]; then
  MODULE="$ROOT/zephyr-module"
  REPO_MOUNT="$ROOT"
else
  MODULE=/repo/zephyr-module
  REPO_MOUNT=/repo
fi

build_one() {
  local board="$1" id="$2" sample="$3" confs="$4" snippets="$5"

  # Board ids carry a slash in hwmv2 (mps2/an385); paths must not.
  local board_dir dest work
  board_dir="$(echo "$board" | tr '/' '_')"
  dest="$ROOT/public/qemu/zephyr/$board_dir"
  # Per-app build dir, so several builds can run at once.
  work="${ZEPHYR_BUILD_WORKDIR:-$ROOT/.zephyr-build}/$board_dir-$id"
  mkdir -p "$dest" "$work"

  # debug-threads.conf → CONFIG_DEBUG_THREAD_INFO (thread state/stack ABI),
  # CONFIG_OBJ_CORE + CONFIG_OBJ_CORE_STATS (typed live kernel-object inventory
  # with participating runtime statistics), and
  # CONFIG_FRAME_POINTER (exact call stacks in the Debug panel).
  # Manifest fragments (relative to zephyr-module/) follow it.
  local conf_list="$MODULE/conf/debug-threads.conf"
  if [ -n "$confs" ]; then
    conf_list="$conf_list;$(echo "$confs" | tr ',' '\n' | sed "s|^|$MODULE/|" | paste -sd';' -)"
  fi
  local cmake_args="-DZEPHYR_EXTRA_MODULES=$MODULE -DSHIELD=$SHIELD -DEXTRA_CONF_FILE='$conf_list'"

  # Snippets come from the module too (its snippet_root), so they are named
  # rather than pathed. `west build -S` takes one per flag.
  local snippet_args=""
  if [ -n "$snippets" ]; then
    local snippet
    for snippet in $(echo "$snippets" | tr ',' ' '); do
      snippet_args="$snippet_args -S '$snippet'"
    done
  fi

  # Stock samples live in the zephyr tree; a sample path starting with
  # "zephyr-module/" is one of this repo's own apps under zephyr-module/apps/,
  # resolved from the repo instead.
  local src="zephyr/$sample"
  case "$sample" in
    zephyr-module/*) src="$REPO_MOUNT/$sample" ;;
  esac

  log "Building $id ($sample) for $board"
  if [ -n "${ZEPHYR_NATIVE:-}" ]; then
    # Drop a prior *container* cache: its absolute paths are /out and /workdir,
    # which west's pristine step cannot resolve on the host.
    if [ -f "$work/build/CMakeCache.txt" ] &&
       grep -qE '(/out/build|/workdir/)' "$work/build/CMakeCache.txt"; then
      rm -rf "$work/build"
    fi
    # Same command string the container path hands to bash -lc, with the build
    # directory reachable directly; eval applies the quoting it carries.
    local build_cmd="west build -p always -b '$board'$snippet_args '$src' -d '$work/build' -- $cmake_args"
    (cd "$ZEPHYR_WS" && eval "$build_cmd")
  else
    # Drop a prior *native* cache: west -p always re-runs pristine.cmake using
    # host absolute paths from CMakeCache, which do not exist inside the
    # container (CMake Error: Not a file: /Users/.../pristine.cmake).
    if [ -f "$work/build/CMakeCache.txt" ] &&
       ! grep -q '/out/build' "$work/build/CMakeCache.txt"; then
      rm -rf "$work/build"
    fi
    docker run --rm \
      -v "$ZEPHYR_WS:/workdir" \
      -v "$work:/out" \
      -v "$ROOT:/repo:ro" \
      -w /workdir \
      "$ZEPHYR_IMAGE" \
      bash -lc "west build -p always -b '$board'$snippet_args '$src' -d /out/build -- $cmake_args"
  fi

  # Ship the unstripped ELF so the page can resolve DEBUG_THREAD_INFO and
  # OBJ_CORE symbols / DWARF layouts. Larger than the old stripped ~64 KB
  # images, but required for the Threads and Kernel Objects tabs.
  cp "$work/build/zephyr/zephyr.elf" "$dest/$id.elf"
  printf '    %-16s %8s bytes\n' "$id.elf" "$(command wc -c < "$dest/$id.elf" | xargs)"

  # The flattened devicetree the build actually used. Shipped verbatim next to
  # the image: the app parses it to ground the peripheral panels, and shows it
  # in the devicetree viewer. Text that gzips to ~10 KB — not worth minifying.
  cp "$work/build/zephyr/zephyr.dts" "$dest/$id.dts"
  printf '    %-16s %8s bytes\n' "$id.dts" "$(command wc -c < "$dest/$id.dts" | xargs)"

  # A sample with a guided tour ships the tour file beside its image, plus a
  # verbatim copy of the sources it points at. Neither is in the ELF and neither
  # changes it: a tour is Markdown the browser reads, and the addresses it
  # breaks on are resolved at runtime from the DWARF already in the image.
  #
  # The sources are copied unmodified, because the line numbers the page
  # resolves out of `.debug_line` are in *those* coordinates. Only the base
  # build ships them — a `_trace` twin is the same sources, and the page reads
  # both from the base id's files.
  local base_id="${id%_trace}"
  local tour="$ROOT/tours/$base_id.tour.md"
  if [ "$id" = "$base_id" ] && [ -f "$tour" ]; then
    cp "$tour" "$dest/$base_id.tour.md"
    printf '    %-16s %8s bytes\n' "$base_id.tour.md" \
      "$(command wc -c < "$dest/$base_id.tour.md" | xargs)"

    local sample_src="$ZEPHYR_WS/zephyr/$sample/src"
    case "$sample" in
      zephyr-module/*) sample_src="$ROOT/$sample/src" ;;
    esac
    if [ -d "$sample_src" ]; then
      rm -rf "$dest/src/$base_id"
      mkdir -p "$dest/src/$base_id"
      find "$sample_src" -maxdepth 1 -type f \( -name '*.c' -o -name '*.h' \) \
        -exec cp {} "$dest/src/$base_id/" \;
      printf '    %-16s %8s file(s)\n' "src/$base_id/" \
        "$(find "$dest/src/$base_id" -type f | command wc -l | xargs)"
    else
      echo "    WARNING: no sources at $sample_src — the tour will show no code." >&2
    fi
  fi

  # The picker in the UI only shows ids it knows about. Traced twins are
  # synthesised in boards.ts (withA53TraceVariants), not listed as literals.
  if ! grep -q "id: '$base_id'" "$ROOT/src/boards.ts"; then
    echo "    WARNING: '$base_id' is not listed in src/boards.ts — the UI cannot offer it." >&2
  fi
}

# Parallel job pool. Each build_one has its own workdir; failures fail the script.
run_pool() {
  local -a pids=()
  local -a specs=()
  local line board id sample confs snippets rc=0 pid
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    specs+=("$line")
  done <<< "$SELECTED"

  log "Building ${#specs[@]} image(s) with up to $JOBS parallel job(s)"

  for line in "${specs[@]}"; do
    IFS=: read -r board id sample confs snippets <<< "$line"
    build_one "$board" "$id" "$sample" "${confs:-}" "${snippets:-}" &
    pids+=("$!")
    if [ "${#pids[@]}" -ge "$JOBS" ]; then
      pid="${pids[0]}"
      pids=("${pids[@]:1}")
      wait "$pid" || rc=1
    fi
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || rc=1
  done
  return "$rc"
}

run_pool

log "Done"
for board_dir in $(echo "$SELECTED" | cut -d: -f1 | tr '/' '_' | sort -u); do
  echo "  public/qemu/zephyr/$board_dir/"
  ls -l "$ROOT/public/qemu/zephyr/$board_dir" | tail -n +2 | awk '{print "   ", $9, $5, "bytes"}'
done
cat <<EOF

App ids must match the samples listed per board in src/boards.ts
(including A53 <id>_trace twins from withA53TraceVariants).
Board argv comes from Zephyr's own boards/qemu/<board>/board.cmake.
Ship it: tools/release.sh images --deploy   (no QEMU rebuild needed)
EOF
