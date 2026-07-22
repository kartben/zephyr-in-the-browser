/**
 * Guest registry.
 *
 * Each entry maps a Zephyr QEMU board target onto the qemu-wasm artifact that
 * can run it plus the argv handed to QEMU. `args` mirror what Zephyr's own
 * `board.cmake` passes (see boards/qemu/<board>/board.cmake upstream), with the
 * paths pointing at `/pack/`, which is where qemu-wasm's file_packager bundle
 * mounts the guest image and BIOS blobs inside the Emscripten filesystem.
 *
 * Adding a board is a data change: build the matching `qemu-system-<arch>` per
 * ktock/qemu-wasm, drop the artifacts into public/qemu/, add an entry here.
 */
export interface Board {
  id: string
  label: string
  /** Zephyr board target this mirrors, i.e. `west build -b <zephyrTarget>`. */
  zephyrTarget: string
  arch: string
  /** Emscripten artifact basename, e.g. `qemu-system-arm` -> qemu-system-arm.wasm */
  qemuBinary: string
  /** QEMU argv, passed through as Module.arguments (argv[0] is implicit). */
  args: string[]
  /** Shown under the selector; keep it to one line. */
  note: string
}

export const BOARDS: Board[] = [
  {
    id: 'qemu_cortex_m3',
    label: 'QEMU Cortex-M3',
    zephyrTarget: 'qemu_cortex_m3',
    arch: 'arm',
    qemuBinary: 'qemu-system-arm',
    args: [
      '-nographic',
      '-machine',
      'lm3s6965evb',
      '-cpu',
      'cortex-m3',
      '-L',
      '/pack/',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    note: '32-bit ARMv7-M guest. Smallest, boots fastest under TCI.',
  },
  {
    id: 'qemu_riscv32',
    label: 'QEMU RISC-V 32',
    zephyrTarget: 'qemu_riscv32',
    arch: 'riscv32',
    qemuBinary: 'qemu-system-riscv32',
    args: [
      '-nographic',
      '-machine',
      'virt',
      '-bios',
      'none',
      '-m',
      '256',
      '-cpu',
      'rv32',
      '-L',
      '/pack/',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    note: 'Match -cpu to the ISA string your Zephyr build reports.',
  },
]

export const DEFAULT_BOARD_ID = BOARDS[0].id

export function getBoard(id: string): Board {
  return BOARDS.find((b) => b.id === id) ?? BOARDS[0]
}
