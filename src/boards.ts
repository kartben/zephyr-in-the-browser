/**
 * Guest registry.
 *
 * Each entry maps a Zephyr QEMU board target onto the qemu-wasm artifact that
 * runs it plus the argv handed to QEMU. `args` mirror what Zephyr's own
 * `board.cmake` passes (see boards/qemu/<board>/board.cmake upstream).
 *
 * Note that `qemuBinary` is the *emulator* build, not the guest architecture:
 * QEMU's aarch64-softmmu target is a superset of arm-softmmu and carries the
 * 32-bit machines too, so one `qemu-system-aarch64` build runs both a Cortex-M3
 * and a Cortex-A53 guest. That is what lets this project use a stock upstream
 * qemu-wasm build instead of needing a bespoke arm-softmmu one.
 *
 * Adding a board is a data change: build the Zephyr image, drop it in
 * public/qemu/zephyr/, add an entry here.
 *
 * Only lm3s6965evb is listed because it is the only machine verified to work on
 * the stock upstream qemu-wasm build. mps2-an385 and a 64-bit Cortex-A53 guest
 * both boot correctly under native QEMU with the argv below but produce no
 * console output under that Wasm build, so they are deliberately absent rather
 * than shipped broken. See public/qemu/README.md.
 */
export interface Board {
  id: string
  label: string
  /** Zephyr board target this mirrors, i.e. `west build -b <zephyrTarget>`. */
  zephyrTarget: string
  /** Guest architecture, for display. */
  arch: string
  /** Emscripten artifact basename, e.g. `qemu-system-aarch64`. */
  qemuBinary: string
  /** QEMU argv, passed through as Module.arguments (argv[0] is implicit). */
  args: string[]
  /**
   * Files fetched over HTTP and written into the Emscripten filesystem before
   * main() runs. This lets a small guest image ride along with a stock qemu-wasm
   * build rather than being baked into a file_packager `.data` bundle — a
   * Zephyr image is tens of kilobytes, so repackaging a multi-megabyte blob to
   * carry it would be absurd.
   *
   * `asset` is relative to public/qemu/.
   */
  preloadFiles: Array<{ fsPath: string; asset: string }>
  /**
   * Whether this board needs a file_packager bundle (`load.js` + `.data`).
   * Required for guests with firmware blobs or a root filesystem; unnecessary
   * for a bare Zephyr ELF.
   */
  usesDataBundle: boolean
  /** Shown under the selector; keep it to one line. */
  note: string
}

export const BOARDS: Board[] = [
  {
    id: 'qemu_cortex_m3',
    label: 'QEMU Cortex-M3',
    zephyrTarget: 'qemu_cortex_m3',
    arch: 'ARMv7-M',
    qemuBinary: 'qemu-system-aarch64',
    args: [
      '-nographic',
      '-machine',
      'lm3s6965evb',
      '-cpu',
      'cortex-m3',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    preloadFiles: [{ fsPath: '/pack/zephyr.elf', asset: 'zephyr/qemu_cortex_m3.elf' }],
    usesDataBundle: false,
    note: 'TI Stellaris LM3S6965. Smallest guest, boots fastest.',
  },
]

export const DEFAULT_BOARD_ID = BOARDS[0].id

export function getBoard(id: string): Board {
  return BOARDS.find((b) => b.id === id) ?? BOARDS[0]
}
