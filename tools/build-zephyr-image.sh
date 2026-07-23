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
#   ZEPHYR_WS     west workspace   (default: ~/zephyrproject)
#   ZEPHYR_IMAGE  container image  (default: ghcr.io/zephyrproject-rtos/zephyr-build:main)
#
# Needs no local Zephyr toolchain — everything runs in the container. Build
# directories are per-app, so independent invocations can run concurrently.
#
# To ship the result, bundle public/qemu/ into a release with
# tools/package-emulator.sh <tag> and point EMULATOR_RELEASE at it (README.md,
# "Deploying to GitHub Pages").

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
# binding, plus the browser_bridge shield the module's board_root exposes.
# Everything is passed as CMake args; note that current Zephyr *rejects*
# -DCONFIG_* on the command line, so Kconfig tweaks travel in .conf fragments
# listed per app in the manifest.
MODULE=/repo/zephyr-module

build_one() {
  local board="$1" id="$2" sample="$3" confs="$4"

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

  log "Building $id ($sample) for $board"
  docker run --rm \
    -v "$ZEPHYR_WS:/workdir" \
    -v "$work:/out" \
    -v "$ROOT:/repo:ro" \
    -w /workdir \
    "$ZEPHYR_IMAGE" \
    bash -lc "west build -p always -b '$board' 'zephyr/$sample' -d /out/build -- $cmake_args"

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
}

while IFS=: read -r board id sample confs; do
  build_one "$board" "$id" "$sample" "${confs:-}"
done <<< "$SELECTED"

log "Done"
for board_dir in $(echo "$SELECTED" | cut -d: -f1 | tr '/' '_' | sort -u); do
  echo "  public/qemu/zephyr/$board_dir/"
  ls -l "$ROOT/public/qemu/zephyr/$board_dir" | tail -n +2 | awk '{print "   ", $9, $5, "bytes"}'
done
cat <<EOF

App ids must match the samples listed per board in src/boards.ts.
Board argv comes from Zephyr's own boards/qemu/<board>/board.cmake.
Ship it: tools/package-emulator.sh <tag>   (bundles public/qemu/ for Pages)
EOF
