#!/usr/bin/env bash
#
# Build the packaged Zephyr samples for the browser and install stripped ELFs
# into public/qemu/zephyr/, where the qemu backend fetches them at runtime.
#
#   tools/build-zephyr-image.sh [board|all] [app|all] [-j N] [-v]
#     board  a board from tools/samples.manifest, or "all" (the default)
#     app    an app id from the manifest, or "all" (the default)
#     -j N   build N images concurrently (default 4, or $ZEPHYR_BUILD_JOBS)
#     -v     stream every build's output live instead of logging it
#
# So a bare `tools/build-zephyr-image.sh` rebuilds every packaged sample for
# every board. The board/app list lives in tools/samples.manifest — adding a
# sample is one manifest line plus its entry in src/boards.ts, then a rerun.
#
# Images land at public/qemu/zephyr/<board>/<app>.elf, named after the *program*
# rather than the board — several apps run on one board, so a board-named file
# said nothing about what would actually boot.
#
# Every build applies the browser_bridge shield (zephyr-module/boards/shields/),
# which adds the browser-fed peripherals — GNSS UART, host GPIO, host audio out
# (I2S), host mic (DMIC), browser-sized ramfb — to the plain QEMU boards.
# Sensors are not among them any more: they are simulated I2C parts carried by
# the virtio-i2c snippet (docs/peripherals.md).
#
# Environment overrides:
#   ZEPHYR_WS     west workspace   (default: ~/zephyrproject)
#   ZEPHYR_IMAGE  container image  (default: ghcr.io/zephyrproject-rtos/zephyr-build:main)
#
# Needs no local Zephyr toolchain — everything runs in the container. Build
# directories are per-app, which is what lets several run at once.
#
# To ship the result, run tools/release.sh images — it packages these into their
# own release asset, separate from the emulator's, and points IMAGES_RELEASE at
# it, so shipping new guests needs no QEMU rebuild (docs/deploying.md).

set -euo pipefail

# Positionals stay positional — tools/release.sh calls this as `... <board> <app>`
# — so flags are simply pulled out of the argument list wherever they appear.
POSITIONAL=()
JOBS="${ZEPHYR_BUILD_JOBS:-4}"
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    -j|--jobs) JOBS="${2:?-j needs a number}"; shift ;;
    -j*)       JOBS="${1#-j}" ;;
    -v|--verbose) VERBOSE=1 ;;
    -h|--help)
      awk 'NR>2 && /^#/ { sub(/^# ?/, ""); print; next } NR>2 { exit }' "${BASH_SOURCE[0]}"
      exit 0 ;;
    -*) echo "Unknown option '$1' (try --help)." >&2; exit 2 ;;
    *)  POSITIONAL+=("$1") ;;
  esac
  shift
done

case "$JOBS" in
  ''|*[!0-9]*) echo "Jobs must be a positive integer (got '$JOBS')." >&2; exit 2 ;;
esac
[ "$JOBS" -ge 1 ] || { echo "Jobs must be at least 1." >&2; exit 2; }

BOARD_FILTER="${POSITIONAL[0]:-all}"
APP_FILTER="${POSITIONAL[1]:-all}"

# One build at a time, or an explicit -v, means the output is followable, so let
# it go straight to the terminal. Otherwise it is captured per job and only
# surfaced if that job fails.
STREAM=0
if [ "$JOBS" = 1 ] || [ "$VERBOSE" = 1 ]; then STREAM=1; fi

ZEPHYR_WS="${ZEPHYR_WS:-$HOME/zephyrproject}"
ZEPHYR_IMAGE="${ZEPHYR_IMAGE:-ghcr.io/zephyrproject-rtos/zephyr-build:main}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/tools/samples.manifest"
SHIELD=browser_bridge

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[ -d "$ZEPHYR_WS/zephyr" ] || {
  echo "No Zephyr tree at $ZEPHYR_WS/zephyr — set ZEPHYR_WS to your west workspace." >&2
  exit 1
}

# Manifest lines, comments and blanks stripped.
ENTRIES="$(grep -Ev '^[[:space:]]*(#|$)' "$MANIFEST")"

known_boards() { echo "$ENTRIES" | cut -d: -f1 | sort -u | tr '\n' ' '; }
known_apps()   { echo "$ENTRIES" | awk -F: -v b="$1" '$1 == b {print $2}' | tr '\n' ' '; }

if [ "$BOARD_FILTER" != "all" ] && ! echo "$ENTRIES" | grep -q "^$BOARD_FILTER:"; then
  echo "Unknown board '$BOARD_FILTER'. Known: $(known_boards)" >&2
  exit 1
fi

SELECTED="$(echo "$ENTRIES" | awk -F: -v b="$BOARD_FILTER" -v a="$APP_FILTER" \
  '(b == "all" || $1 == b) && (a == "all" || $2 == a)')"
[ -n "$SELECTED" ] || {
  echo "Unknown app '$APP_FILTER' for board '$BOARD_FILTER'." >&2
  echo "Known apps for $BOARD_FILTER: $(known_apps "$BOARD_FILTER")" >&2
  exit 1
}

# This repo ships an out-of-tree Zephyr module: its drivers and bindings, plus
# the browser_bridge shield the module's board_root exposes and the snippets its
# snippet_root exposes. Everything is passed as CMake args;
# note that current Zephyr *rejects* -DCONFIG_* on the command line, so Kconfig
# tweaks travel in .conf fragments listed per app in the manifest.
MODULE=/repo/zephyr-module

build_one() {
  local board="$1" id="$2" sample="$3" confs="$4" snippets="$5"
  local started
  started="$(date +%s)"

  # Board ids carry a slash in hwmv2 (mps2/an385); paths must not.
  local board_dir dest work
  board_dir="$(echo "$board" | tr '/' '_')"
  dest="$ROOT/public/qemu/zephyr/$board_dir"
  # Per-app build dir, so several builds can run at once.
  work="${ZEPHYR_BUILD_WORKDIR:-$ROOT/.zephyr-build}/$board_dir-$id"
  mkdir -p "$dest" "$work"

  local cmake_args="-DZEPHYR_EXTRA_MODULES=$MODULE -DSHIELD=$SHIELD"
  if [ -n "$confs" ]; then
    # Manifest fragments are relative to zephyr-module/; several join with ';'.
    # The quotes keep the ; from splitting the outer bash -lc command before
    # Zephyr sees the list.
    local conf_list
    conf_list="$(echo "$confs" | tr ',' '\n' | sed "s|^|$MODULE/|" | paste -sd';' -)"
    cmake_args="$cmake_args -DEXTRA_CONF_FILE='$conf_list'"
  fi

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
  # "zephyr-module/" is one of this repo's own apps under zephyr-module/apps/
  # (none packaged right now), resolved from the repo mount instead.
  local src="zephyr/$sample"
  case "$sample" in
    zephyr-module/*) src="/repo/$sample" ;;
  esac

  log "Building $id ($sample) for $board"
  docker run --rm \
    -v "$ZEPHYR_WS:/workdir" \
    -v "$work:/out" \
    -v "$ROOT:/repo:ro" \
    -w /workdir \
    "$ZEPHYR_IMAGE" \
    bash -lc "west build -p always -b '$board'$snippet_args '$src' -d /out/build -- $cmake_args"

  # The linked ELF is mostly DWARF — ~1.5 MB against ~64 KB of loadable image —
  # and it is fetched over HTTP on every boot, so strip it. The right strip
  # binary depends on the guest arch, so pick it from the ELF's own machine type.
  docker run --rm -v "$work:/out" "$ZEPHYR_IMAGE" bash -lc '
    set -euo pipefail
    elf=/out/build/zephyr/zephyr.elf
    machine=$(readelf -h "$elf" | awk -F: "/Machine:/ {print \$2}" | xargs)
    case "$machine" in
      *AArch64*)   prefix=aarch64-zephyr-elf ;;
      *ARM*)       prefix=arm-zephyr-eabi ;;
      *RISC-V*)    prefix=riscv64-zephyr-elf ;;
      *X86-64*|*Intel*) prefix=x86_64-zephyr-elf ;;
      *) echo "unhandled ELF machine: $machine" >&2; exit 1 ;;
    esac
    strip=$(find /opt/toolchains -name "${prefix}-strip" | head -1)
    [ -n "$strip" ] || { echo "no strip for $prefix" >&2; exit 1; }
    "$strip" -o /out/stripped.elf "$elf"
  '

  cp "$work/stripped.elf" "$dest/$id.elf"
  printf '    %-16s %8s bytes\n' "$id.elf" "$(command wc -c < "$dest/$id.elf" | xargs)"

  # The picker in the UI only shows ids it knows about.
  grep -q "id: '$id'" "$ROOT/src/boards.ts" \
    || echo "    WARNING: '$id' is not listed in src/boards.ts — the UI cannot offer it." >&2

  # Left for the parent to print once this job is reaped: when output is being
  # captured, this line is the only part of the job worth showing on success.
  printf '%-28s %8s bytes  %3ds\n' "$board_dir/$id" \
    "$(command wc -c < "$dest/$id.elf" | xargs)" "$(( $(date +%s) - started ))" \
    > "$work/summary"
}

# --- the job pool -----------------------------------------------------------
#
# `wait -n` and associative arrays would make this shorter, but both are bash
# 4.x and macOS still ships 3.2, so slots are polled and the bookkeeping rides
# on parallel indexed arrays. Against builds that take minutes, the poll costs
# nothing.

JOB_PIDS=()
JOB_TAGS=()
JOB_LOGS=()

wait_for_slot() {
  while [ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$JOBS" ]; do sleep 0.2; done
}

start_job() {
  local board="$1" id="$2" sample="$3" confs="$4" snippets="$5"
  local board_dir work log tag
  board_dir="$(echo "$board" | tr '/' '_')"
  work="${ZEPHYR_BUILD_WORKDIR:-$ROOT/.zephyr-build}/$board_dir-$id"
  tag="$board_dir/$id"
  mkdir -p "$work"
  log="$work/build.log"
  rm -f "$work/summary"

  if [ "$STREAM" = 1 ] && [ "$JOBS" = 1 ]; then
    ( build_one "$board" "$id" "$sample" "$confs" "$snippets" ) &
  elif [ "$STREAM" = 1 ]; then
    # Interleaved live output is only readable if every line says whose it is.
    ( build_one "$board" "$id" "$sample" "$confs" "$snippets" 2>&1 \
        | awk -v p="[$tag] " '{ print p $0; fflush() }' ) &
  else
    printf '    %-28s building…\n' "$tag"
    # The job announces its own completion, so finished builds show up as they
    # land rather than in a burst when the slowest one is finally reaped.
    ( build_one "$board" "$id" "$sample" "$confs" "$snippets" >"$log" 2>&1 \
        && printf '    ✓ %s\n' "$(cat "$work/summary")" ) &
  fi

  JOB_PIDS+=($!)
  JOB_TAGS+=("$tag")
  JOB_LOGS+=("$log")
}

if [ "$JOBS" -gt 1 ]; then
  log "Building $(echo "$SELECTED" | wc -l | tr -d ' ') images, $JOBS at a time"
fi

while IFS=: read -r board id sample confs snippets; do
  wait_for_slot
  start_job "$board" "$id" "$sample" "${confs:-}" "${snippets:-}"
done <<< "$SELECTED"

# Reap everything before reporting: one broken sample should not hide the
# results of the builds that were already in flight beside it.
FAILED_TAGS=()
FAILED_LOGS=()
i=0
while [ "$i" -lt "${#JOB_PIDS[@]}" ]; do
  if ! wait "${JOB_PIDS[$i]}"; then
    FAILED_TAGS+=("${JOB_TAGS[$i]}")
    FAILED_LOGS+=("${JOB_LOGS[$i]}")
  fi
  i=$((i + 1))
done

if [ "${#FAILED_TAGS[@]}" -gt 0 ]; then
  i=0
  while [ "$i" -lt "${#FAILED_TAGS[@]}" ]; do
    log "FAILED: ${FAILED_TAGS[$i]}"
    if [ "$STREAM" != 1 ] && [ -f "${FAILED_LOGS[$i]}" ]; then
      tail -40 "${FAILED_LOGS[$i]}" | sed 's/^/    /'
      echo "    (full log: ${FAILED_LOGS[$i]})"
    fi
    i=$((i + 1))
  done
  echo >&2
  echo "${#FAILED_TAGS[@]} of ${#JOB_PIDS[@]} builds failed." >&2
  exit 1
fi

log "Done"
for board_dir in $(echo "$SELECTED" | cut -d: -f1 | tr '/' '_' | sort -u); do
  echo "  public/qemu/zephyr/$board_dir/"
  ls -l "$ROOT/public/qemu/zephyr/$board_dir" | tail -n +2 | awk '{print "   ", $9, $5, "bytes"}'
done
cat <<EOF

App ids must match the samples listed per board in src/boards.ts.
Board argv comes from Zephyr's own boards/qemu/<board>/board.cmake.
Ship it: tools/release.sh images --deploy   (no QEMU rebuild needed)
EOF
