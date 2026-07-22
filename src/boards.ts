/**
 * Guest registry: the machines QEMU can emulate, and the images each can boot.
 *
 * A board is *hardware* — machine model, CPU, argv. An image is a *program* that
 * runs on it. They are deliberately separate: several images run on one board,
 * and a user-supplied ELF replaces the image without touching the machine.
 *
 * Note `qemuBinary` is the emulator build, not the guest architecture: QEMU's
 * aarch64-softmmu target is a superset of arm-softmmu and carries the 32-bit
 * machines too. This project builds arm-softmmu directly (tools/build-qemu-wasm.sh).
 *
 * Only lm3s6965evb is listed because it is the only machine verified to work
 * under qemu-wasm. mps2-an385 and a 64-bit Cortex-A53 guest both boot correctly
 * under native QEMU with the argv below but produce no console output on the
 * Wasm build, so they are absent rather than shipped broken. See
 * public/qemu/README.md.
 */

/** A prebuilt guest image. Produced by tools/build-zephyr-image.sh. */
export interface GuestSample {
  /** Also the artifact basename, so it must stay in step with the build script. */
  id: string
  label: string
  /** One line, shown under the label in the picker. */
  description: string
  /** Zephyr sample path, relative to the zephyr/ tree. */
  zephyrSample: string
}

export interface Board {
  id: string
  label: string
  /** Zephyr board target, i.e. `west build -b <zephyrTarget>`. */
  zephyrTarget: string
  /** Guest architecture, for display. */
  arch: string
  /** Emscripten artifact basename, e.g. `qemu-system-arm`. */
  qemuBinary: string
  /** QEMU argv, passed as Module.arguments (argv[0] is implicit). */
  args: string[]
  /** Where the kernel lands in the Emscripten filesystem; matches `-kernel`. */
  kernelFsPath: string
  samples: GuestSample[]
  defaultSampleId: string
  /**
   * Anything else the guest needs in its filesystem — firmware blobs and the
   * like. None of the current boards need any.
   */
  extraFiles?: Array<{ fsPath: string; asset: string }>
  /**
   * Whether this board needs a file_packager bundle (`load.js` + `.data`).
   * Unnecessary for a bare ELF, which is fetched and injected directly.
   */
  usesDataBundle: boolean
}

/*
 * Only apps that do not sleep. Anything blocking on k_sleep or a timeout hangs
 * under qemu-wasm: Philosophers and Synchronization were both shipped here and
 * both stall, though they run correctly on native QEMU 8.2.2 — the same version
 * ktock's fork is based on.
 *
 * The cause is ktock's TCG→Wasm JIT miscompiling something, not the guest and
 * not the SysTick device: forcing everything to stay interpreted takes
 * Synchronization from 1 line to 14, deterministically. It still stalls, so
 * there is a further defect too.
 *
 * Note the "Timer with period zero, disabling" line on every boot is *not* the
 * cause, however much it looks like it — native QEMU prints it too on runs that
 * work. See public/qemu/README.md for the full trace.
 */
const CORTEX_M3_SAMPLES: GuestSample[] = [
  {
    id: 'shell',
    label: 'Shell',
    description: 'Interactive Zephyr shell, with `sensor get`',
    zephyrSample: 'samples/subsys/shell/shell_module',
  },
  {
    id: 'hello_world',
    label: 'Hello World',
    description: 'Prints one line and stops',
    zephyrSample: 'samples/hello_world',
  },
]

export const BOARDS: Board[] = [
  {
    id: 'qemu_cortex_m3',
    label: 'QEMU Cortex-M3',
    zephyrTarget: 'qemu_cortex_m3',
    arch: 'ARMv7-M',
    qemuBinary: 'qemu-system-arm',
    args: [
      '-nographic',
      '-machine',
      'lm3s6965evb',
      '-cpu',
      'cortex-m3',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    kernelFsPath: '/pack/zephyr.elf',
    samples: CORTEX_M3_SAMPLES,
    // The shell is the one worth landing on: it is interactive, and it is where
    // the host-sensor bridge is visible.
    defaultSampleId: 'shell',
    usesDataBundle: false,
  },
]

export const DEFAULT_BOARD_ID = BOARDS[0].id

export function getBoard(id: string): Board {
  return BOARDS.find((b) => b.id === id) ?? BOARDS[0]
}

export function getSample(board: Board, sampleId: string): GuestSample {
  return board.samples.find((s) => s.id === sampleId) ?? board.samples[0]
}

/** Where a board's prebuilt image lives under public/qemu/. */
export function sampleAsset(board: Board, sampleId: string): string {
  return `zephyr/${board.zephyrTarget}/${sampleId}.elf`
}
