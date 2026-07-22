#!/usr/bin/env bash
#
# Build a Zephyr sample for a QEMU board and install a stripped ELF into
# public/qemu/zephyr/, where the qemu backend fetches it at runtime.
#
#   tools/build-zephyr-image.sh [board] [sample]
#     board  defaults to qemu_cortex_m3
#     sample defaults to samples/subsys/shell/shell_module (relative to zephyr/)
#
# Environment overrides:
#   ZEPHYR_WS     west workspace   (default: ~/zephyrproject)
#   ZEPHYR_IMAGE  container image  (default: ghcr.io/zephyrproject-rtos/zephyr-build:main)
#
# Needs no local Zephyr toolchain — everything runs in the container.

set -euo pipefail

BOARD="${1:-qemu_cortex_m3}"
SAMPLE="${2:-samples/subsys/shell/shell_module}"
ZEPHYR_WS="${ZEPHYR_WS:-$HOME/zephyrproject}"
ZEPHYR_IMAGE="${ZEPHYR_IMAGE:-ghcr.io/zephyrproject-rtos/zephyr-build:main}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/public/qemu/zephyr"
WORK="${ZEPHYR_BUILD_WORKDIR:-$ROOT/.zephyr-build}"

# Board ids carry a slash in hwmv2 (mps2/an385); the artifact name must not.
OUTNAME="$(echo "$BOARD" | tr '/' '_').elf"

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[ -d "$ZEPHYR_WS/zephyr" ] || {
  echo "No Zephyr tree at $ZEPHYR_WS/zephyr — set ZEPHYR_WS to your west workspace." >&2
  exit 1
}

mkdir -p "$WORK" "$DEST"

# This repo ships an out-of-tree Zephyr module (the qemu,host-sensor driver and
# its binding) plus Kconfig and devicetree overlays. Everything below is passed
# as CMake args; note that current Zephyr *rejects* -DCONFIG_* on the command
# line, so Kconfig changes have to travel in a .conf file.
MODULE=/repo/zephyr-module
CMAKE_ARGS="-DZEPHYR_EXTRA_MODULES=$MODULE"
CMAKE_ARGS="$CMAKE_ARGS -DEXTRA_CONF_FILE=$MODULE/overlays/host-sensor.conf"

# The MMIO address the sensor lives at is board-specific, so the overlay is too.
# Boards without one simply build without the device.
if [ -f "$ROOT/zephyr-module/overlays/$(echo "$BOARD" | tr '/' '_').overlay" ]; then
  CMAKE_ARGS="$CMAKE_ARGS -DEXTRA_DTC_OVERLAY_FILE=$MODULE/overlays/$(echo "$BOARD" | tr '/' '_').overlay"
  log "Including host-sensor overlay for $BOARD"
else
  log "No host-sensor overlay for $BOARD — building without the device"
fi

log "Building $SAMPLE for $BOARD"
docker run --rm \
  -v "$ZEPHYR_WS:/workdir" \
  -v "$WORK:/out" \
  -v "$ROOT:/repo:ro" \
  -w /workdir \
  "$ZEPHYR_IMAGE" \
  bash -lc "west build -p always -b '$BOARD' 'zephyr/$SAMPLE' -d /out/build -- $CMAKE_ARGS"

# The linked ELF is mostly DWARF — ~1.5 MB against ~64 KB of loadable image —
# and it is fetched over HTTP on every boot, so strip it. The right strip binary
# depends on the guest arch, so pick it from the ELF's own machine type.
log "Stripping"
docker run --rm -v "$WORK:/out" "$ZEPHYR_IMAGE" bash -lc '
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
  echo "  machine=$machine -> $(basename "$strip")"
  "$strip" -o /out/stripped.elf "$elf"
'

cp "$WORK/stripped.elf" "$DEST/$OUTNAME"

log "Done"
ls -l "$DEST/$OUTNAME"
cat <<EOF

Wire it up in src/boards.ts:
  preloadFiles: [{ fsPath: '/pack/zephyr.elf', asset: 'zephyr/$OUTNAME' }]

Check the board's argv against Zephyr's own boards/qemu/<board>/board.cmake —
that is where the -machine/-cpu flags in src/boards.ts come from.
EOF
