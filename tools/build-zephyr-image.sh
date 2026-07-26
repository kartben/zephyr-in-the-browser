#!/usr/bin/env bash
#
# Build the packaged Zephyr samples for the browser and install stripped ELFs
# into public/qemu/zephyr/, where the qemu backend fetches them at runtime.
#
#   tools/build-zephyr-image.sh [board|all] [app|all]
#     board  a board from tools/samples.manifest, or "all" (the default)
#     app    an app id from the manifest, or "all" (the default)
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
# which adds the browser-fed peripherals — GNSS UART, host sensor with its
# accel0/temp0/... aliases, host GPIO, host audio out (I2S), host mic (DMIC),
# browser-sized ramfb — to the plain QEMU boards.
#
# Environment overrides:
#   ZEPHYR_WS      west workspace   (default: ~/zephyrproject)
#   ZEPHYR_IMAGE   container image  (default: ghcr.io/zephyrproject-rtos/zephyr-build:main)
#   ZEPHYR_NATIVE  if non-empty, run west and the SDK tools directly instead of
#                  in the container — for environments that already carry a
#                  workspace, toolchains and west on PATH, like the CI runner
#                  that .github/workflows/build-images.yml prepares with
#                  zephyrproject-rtos/action-zephyr-setup.
#
# In the default (container) mode this needs no local Zephyr toolchain —
# everything runs in the container. Build directories are per-app, so
# independent invocations can run concurrently.
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

# This repo ships an out-of-tree Zephyr module: the qemu,host-sensor driver and
# binding, plus the browser_bridge shield the module's board_root exposes and
# the snippets its snippet_root exposes. Everything is passed as CMake args;
# note that current Zephyr *rejects* -DCONFIG_* on the command line, so Kconfig
# tweaks travel in .conf fragments listed per app in the manifest.
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

  # Every packaged build carries conf/stripped.conf: what ships is the
  # zephyr.strip the build emits itself, produced by the same toolchain that
  # linked the ELF — no strip binary for this script to locate, in either
  # mode. Manifest fragments (relative to zephyr-module/) follow it; several
  # join with ';', and the quotes keep the ';' from splitting the outer
  # bash -lc command before Zephyr sees the list.
  local conf_list="$MODULE/conf/stripped.conf"
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
  # "zephyr-module/" is one of this repo's own apps under zephyr-module/apps/
  # (none packaged right now), resolved from the repo instead.
  local src="zephyr/$sample"
  case "$sample" in
    zephyr-module/*) src="$REPO_MOUNT/$sample" ;;
  esac

  log "Building $id ($sample) for $board"
  if [ -n "${ZEPHYR_NATIVE:-}" ]; then
    # Same command string the container path hands to bash -lc, with the build
    # directory reachable directly; eval applies the quoting it carries.
    local build_cmd="west build -p always -b '$board'$snippet_args '$src' -d '$work/build' -- $cmake_args"
    (cd "$ZEPHYR_WS" && eval "$build_cmd")
  else
    docker run --rm \
      -v "$ZEPHYR_WS:/workdir" \
      -v "$work:/out" \
      -v "$ROOT:/repo:ro" \
      -w /workdir \
      "$ZEPHYR_IMAGE" \
      bash -lc "west build -p always -b '$board'$snippet_args '$src' -d /out/build -- $cmake_args"
  fi

  # The linked ELF is mostly DWARF — ~1.5 MB against ~64 KB of loadable image —
  # and it is fetched over HTTP on every boot, so ship the stripped copy that
  # CONFIG_BUILD_OUTPUT_STRIPPED (conf/stripped.conf, above) made the build
  # produce.
  cp "$work/build/zephyr/zephyr.strip" "$dest/$id.elf"
  printf '    %-16s %8s bytes\n' "$id.elf" "$(command wc -c < "$dest/$id.elf" | xargs)"

  # The flattened devicetree the build actually used. Shipped verbatim next to
  # the image: the app parses it to ground the peripheral panels, and shows it
  # in the devicetree viewer. Text that gzips to ~10 KB — not worth minifying.
  cp "$work/build/zephyr/zephyr.dts" "$dest/$id.dts"
  printf '    %-16s %8s bytes\n' "$id.dts" "$(command wc -c < "$dest/$id.dts" | xargs)"

  # An annotated sample also emits its teaching prose and a display copy of its
  # sources (tools/extract-annotations.py, run from the app's CMakeLists). None
  # of it is in the ELF — the firmware carries ids, the page carries the words —
  # so both ride along here beside the image, like the devicetree above.
  #
  # The sources are the *stripped* copies, with the @annotate blocks removed:
  # their text is already in the popup, and leaving it in would bury the code it
  # explains. Line numbers in annotations.json are in those coordinates.
  local ann="$work/build/annotations"
  if [ -f "$ann/annotations.json" ]; then
    cp "$ann/annotations.json" "$dest/$id.annotations.json"
    printf '    %-16s %8s bytes\n' "$id.annotations.json" \
      "$(command wc -c < "$dest/$id.annotations.json" | xargs)"
    rm -rf "$dest/src/$id"
    mkdir -p "$dest/src/$id"
    cp -R "$ann/display/." "$dest/src/$id/"
    printf '    %-16s %8s file(s)\n' "src/$id/" \
      "$(find "$dest/src/$id" -type f | command wc -l | xargs)"
  fi

  # The picker in the UI only shows ids it knows about.
  grep -q "id: '$id'" "$ROOT/src/boards.ts" \
    || echo "    WARNING: '$id' is not listed in src/boards.ts — the UI cannot offer it." >&2
}

while IFS=: read -r board id sample confs snippets; do
  build_one "$board" "$id" "$sample" "${confs:-}" "${snippets:-}"
done <<< "$SELECTED"

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
