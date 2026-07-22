#!/usr/bin/env bash
#
# Build a Zephyr sample for a QEMU board and install a stripped ELF into
# public/qemu/zephyr/, where the qemu backend fetches it at runtime.
#
#   tools/build-zephyr-image.sh [board] [app|all]
#     board  defaults to qemu_cortex_m3
#     app    one of the ids in APPS below, or "all" (the default)
#
# Images land at public/qemu/zephyr/<board>/<app>.elf, named after the *program*
# rather than the board — several apps run on one board, so a board-named file
# said nothing about what would actually boot.
#
# Environment overrides:
#   ZEPHYR_WS     west workspace   (default: ~/zephyrproject)
#   ZEPHYR_IMAGE  container image  (default: ghcr.io/zephyrproject-rtos/zephyr-build:main)
#
# Needs no local Zephyr toolchain — everything runs in the container.

set -euo pipefail

BOARD="${1:-qemu_cortex_m3}"
APP="${2:-all}"

# Must stay in step with the samples listed for each board in src/boards.ts.
# Cortex-M apps that block on k_sleep remain absent because they still stall on
# qemu-wasm's TCI path. Cortex-A53 uses its architectural timer and is the board
# that provides fw_cfg + qemu,ramfb.
case "$BOARD" in
  qemu_cortex_m3)
    APPS="gnss:samples/drivers/gnss
shell:samples/subsys/shell/shell_module
hello_world:samples/hello_world"
    ;;
  qemu_cortex_a53)
    APPS="gnss:samples/drivers/gnss
display:samples/drivers/display
hello_world:samples/hello_world"
    ;;
  *)
    echo "Unsupported board '$BOARD'. Known: qemu_cortex_m3 qemu_cortex_a53" >&2
    exit 1
    ;;
esac
ZEPHYR_WS="${ZEPHYR_WS:-$HOME/zephyrproject}"
ZEPHYR_IMAGE="${ZEPHYR_IMAGE:-ghcr.io/zephyrproject-rtos/zephyr-build:main}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${ZEPHYR_BUILD_WORKDIR:-$ROOT/.zephyr-build}"

# Board ids carry a slash in hwmv2 (mps2/an385); paths must not.
BOARD_DIR="$(echo "$BOARD" | tr '/' '_')"
DEST="$ROOT/public/qemu/zephyr/$BOARD_DIR"

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

[ -d "$ZEPHYR_WS/zephyr" ] || {
  echo "No Zephyr tree at $ZEPHYR_WS/zephyr — set ZEPHYR_WS to your west workspace." >&2
  exit 1
}

mkdir -p "$WORK" "$DEST"

# This repo ships an out-of-tree Zephyr module (the qemu,host-sensor driver and
# its binding) plus board-specific devicetree overlays. Everything below is
# passed as CMake args; note that current Zephyr *rejects* -DCONFIG_* on the
# command line, so Kconfig changes have to travel in a .conf file.
MODULE=/repo/zephyr-module
CMAKE_ARGS="-DZEPHYR_EXTRA_MODULES=$MODULE"

# Board overlays may add a host peripheral or tune an emulated one. Boards
# without one simply use Zephyr's stock devicetree.
BOARD_OVERLAY="$ROOT/zephyr-module/overlays/$BOARD_DIR.overlay"
if [ -f "$BOARD_OVERLAY" ]; then
  CMAKE_ARGS="$CMAKE_ARGS -DEXTRA_DTC_OVERLAY_FILE=$MODULE/overlays/$BOARD_DIR.overlay"
  log "Including board overlay for $BOARD"
else
  log "No board overlay for $BOARD — building stock Zephyr peripherals"
fi

# Selected apps, as "id:path" lines.
if [ "$APP" = "all" ]; then
  SELECTED="$APPS"
else
  SELECTED=$(echo "$APPS" | grep "^$APP:" || true)
  [ -n "$SELECTED" ] || {
    echo "Unknown app '$APP'. Known: $(echo "$APPS" | cut -d: -f1 | tr '\n' ' ')" >&2
    exit 1
  }
fi

build_one() {
  local id="$1" sample="$2"
  local app_cmake_args="$CMAKE_ARGS"

  # Keep app-specific subsystems out of unrelated images. The M3 shell exposes
  # the host sensor, while the generic GNSS modem backend needs IRQ-driven UART
  # reception on both boards.
  if [ "$BOARD" = "qemu_cortex_m3" ] && [ "$id" = "shell" ]; then
    app_cmake_args="$app_cmake_args -DEXTRA_CONF_FILE=$MODULE/overlays/host-sensor.conf"
  elif [ "$id" = "gnss" ]; then
    app_cmake_args="$app_cmake_args -DEXTRA_CONF_FILE=$MODULE/overlays/gnss-uart.conf"
  fi

  log "Building $id ($sample) for $BOARD"
  docker run --rm \
    -v "$ZEPHYR_WS:/workdir" \
    -v "$WORK:/out" \
    -v "$ROOT:/repo:ro" \
    -w /workdir \
    "$ZEPHYR_IMAGE" \
    bash -lc "west build -p always -b '$BOARD' 'zephyr/$sample' -d /out/build -- $app_cmake_args"

  # The linked ELF is mostly DWARF — ~1.5 MB against ~64 KB of loadable image —
  # and it is fetched over HTTP on every boot, so strip it. The right strip
  # binary depends on the guest arch, so pick it from the ELF's own machine type.
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
    "$strip" -o /out/stripped.elf "$elf"
  '

  cp "$WORK/stripped.elf" "$DEST/$id.elf"
  printf '    %-16s %8s bytes\n' "$id.elf" "$(command wc -c < "$DEST/$id.elf" | xargs)"
}

while IFS=: read -r id sample; do
  [ -n "$id" ] || continue
  build_one "$id" "$sample"
done <<< "$SELECTED"

log "Done — public/qemu/zephyr/$BOARD_DIR/"
ls -l "$DEST" | tail -n +2 | awk '{print "   ", $9, $5, "bytes"}'
cat <<EOF

These ids must match the samples listed for this board in src/boards.ts.
Board argv comes from Zephyr's own boards/qemu/<board>/board.cmake.
EOF
