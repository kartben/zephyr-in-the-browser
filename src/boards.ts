/**
 * Guest registry: the machines QEMU can emulate, and the images each can boot.
 *
 * A board is *hardware* — machine model, CPU, argv. An image is a *program* that
 * runs on it. They are deliberately separate: several images run on one board,
 * and a user-supplied ELF replaces the image without touching the machine.
 *
 * `qemuBinary` selects the matching Emscripten JS/Wasm artifact pair. The
 * Cortex-M3 uses arm-softmmu; the 64-bit `virt` machine needed by qemu,ramfb
 * uses aarch64-softmmu.
 */

/** A peripheral bridge with a floating panel in the UI. */
export type PanelKind = 'display' | 'gnss' | 'sensor' | 'gpio' | 'audio' | 'perf' | 'net'

/** A prebuilt guest image. Produced by tools/build-zephyr-image.sh. */
export interface GuestSample {
  /** Also the artifact basename, so it must stay in step with the build script. */
  id: string
  label: string
  /** One line, shown under the label in the picker. */
  description: string
  /**
   * Zephyr sample path, relative to the zephyr/ tree — or one of this repo's
   * own apps when it starts with "zephyr-module/".
   */
  zephyrSample: string
  /**
   * Panels this sample is *about* — expanded on boot so the relevant bridge is
   * in view immediately. Every other available panel starts collapsed, since it
   * is incidental to what the sample demonstrates. Omit for samples that only
   * speak over the terminal.
   */
  primaryPanels?: PanelKind[]
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
  /** Optional browser bridges physically present on this machine. */
  peripherals?: {
    gnss?: boolean
    hostSensor?: boolean
    hostGpio?: boolean
    hostAudio?: boolean
    hostMic?: boolean
    ramfb?: boolean
    /** Guest-throughput (MIPS) readout; needs a `-icount` machine to advance. */
    perfStats?: boolean
    /** Ethernet through the `browser` netdev; the page implements the LAN. */
    hostNet?: boolean
  }
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
 * Sleeping is mostly fine, but a couple of multi-threaded samples hang:
 * Philosophers and Synchronization were both shipped here and both stall under
 * qemu-wasm, though they run correctly on native QEMU (including 10.0.50, the
 * version ktock's fork is based on). Single-threaded sleepers are unaffected:
 * blinky (a k_msleep loop) and basic_button (a polled gpio-keys work item) run
 * steadily — only the wall clock is off, the interpreter runs the 1 Hz blink
 * several times faster than real time.
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
    id: 'gnss',
    label: 'GNSS',
    description: 'Parses browser-fed NMEA fixes over UART',
    zephyrSample: 'samples/drivers/gnss',
    primaryPanels: ['gnss'],
  },
  {
    id: 'shell',
    label: 'Shell',
    description: 'Interactive Zephyr shell, with `sensor get`, `gpio` and `hostaudio`',
    zephyrSample: 'samples/subsys/shell/shell_module',
    // The shell is the interface to all three host bridges it advertises.
    primaryPanels: ['sensor', 'gpio', 'audio'],
  },
  {
    // Event-driven end to end (shell in, logs out), so it dodges the TCI
    // k_sleep stall that keeps most samples off this board.
    id: 'hsm',
    label: 'State Machine',
    description: 'Hierarchical state machine driven from the shell',
    zephyrSample: 'samples/subsys/smf/hsm_psicc2',
  },
  {
    // main() returns after kicking DHCP off; progress rides the RX interrupt
    // chain, so it dodges the TCI k_sleep stall.
    id: 'dhcp',
    label: 'DHCP Client',
    description: 'Acquires an IPv4 lease from the browser network',
    zephyrSample: 'samples/net/dhcpv4_client',
    primaryPanels: ['net'],
  },
  {
    // Steady state blocks in accept()/recv(), woken by injected frames.
    id: 'http_server',
    label: 'HTTP Server',
    description: 'Serves a page at 192.0.2.1:8080 — fetch it from the Network panel',
    zephyrSample: 'samples/net/sockets/dumb_http_server',
    primaryPanels: ['net'],
  },
  {
    // Run-to-completion: one DNS lookup, one GET, prints, exits.
    id: 'http_get',
    label: 'HTTP GET',
    description: 'DNS + TCP fetch of http://google.com through the page proxy',
    zephyrSample: 'samples/net/sockets/http_get',
    primaryPanels: ['net'],
  },
  {
    id: 'hello_world',
    label: 'Hello World',
    description: 'Prints one line and stops',
    zephyrSample: 'samples/hello_world',
  },
  {
    // led0 is the host-gpio bridge's pin 4 (LED0 in the panel), so the blink
    // shows up as the panel's LED0 flashing once a second.
    id: 'blinky',
    label: 'Blinky',
    description: 'Blinks LED0 on the host GPIO bridge',
    zephyrSample: 'samples/basic/blinky',
    primaryPanels: ['gpio'],
  },
  {
    // A polled gpio-keys button (SW0, pin 0) drives the input subsystem, which
    // lights led0 (pin 4) — click SW0 in the GPIO panel to press it.
    id: 'basic_button',
    label: 'Button',
    description: 'A host GPIO button lights an LED via the input subsystem',
    zephyrSample: 'samples/basic/button',
    primaryPanels: ['gpio'],
  },
]

const CORTEX_A53_SAMPLES: GuestSample[] = [
  {
    id: 'gnss',
    label: 'GNSS',
    description: 'Parses browser-fed NMEA fixes over UART',
    zephyrSample: 'samples/drivers/gnss',
    primaryPanels: ['gnss'],
  },
  {
    id: 'display',
    label: 'Display',
    description: 'Draws Zephyr’s display test pattern through qemu,ramfb',
    zephyrSample: 'samples/drivers/display',
    primaryPanels: ['display'],
  },
  {
    id: 'lvgl_music',
    label: 'Music Player',
    description: 'LVGL’s auto-playing music player on qemu,ramfb',
    zephyrSample: 'samples/modules/lvgl/demos',
    primaryPanels: ['display'],
  },
  {
    id: 'accel_chart',
    label: 'Accelerometer Chart',
    description: 'Browser accelerometer traced live on an LVGL chart',
    zephyrSample: 'samples/modules/lvgl/accelerometer_chart',
    // The accelerometer feeds the chart, so surface both input and output.
    primaryPanels: ['sensor', 'display'],
  },
  {
    id: 'philosophers',
    label: 'Philosophers',
    description: 'Dining philosophers, animated in-place over VT100',
    zephyrSample: 'samples/philosophers',
  },
  {
    id: 'shell',
    label: 'Shell',
    description: 'Interactive Zephyr shell, with `hostaudio` and `dmic` for the sound panel',
    zephyrSample: 'samples/subsys/shell/shell_module',
    primaryPanels: ['audio'],
  },
  {
    id: 'hsm',
    label: 'State Machine',
    description: 'Hierarchical state machine driven from the shell',
    zephyrSample: 'samples/subsys/smf/hsm_psicc2',
  },
  {
    id: 'dhcp',
    label: 'DHCP Client',
    description: 'Acquires an IPv4 lease from the browser network',
    zephyrSample: 'samples/net/dhcpv4_client',
    primaryPanels: ['net'],
  },
  {
    id: 'http_server',
    label: 'HTTP Server',
    description: 'Serves a page at 192.0.2.1:8080 — fetch it from the Network panel',
    zephyrSample: 'samples/net/sockets/dumb_http_server',
    primaryPanels: ['net'],
  },
  {
    id: 'echo_server',
    label: 'Echo Server',
    description: 'TCP/UDP echo on port 4242 — ping it from the Network panel',
    zephyrSample: 'samples/net/sockets/echo_server',
    primaryPanels: ['net'],
  },
  {
    id: 'http_get',
    label: 'HTTP GET',
    description: 'DNS + TCP fetch of http://google.com through the page proxy',
    zephyrSample: 'samples/net/sockets/http_get',
    primaryPanels: ['net'],
  },
  {
    id: 'zperf',
    label: 'zperf',
    description: 'iperf2-style throughput benchmark against the page',
    zephyrSample: 'samples/net/zperf',
    primaryPanels: ['net'],
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
      // Pair the machine's stellaris_enet with the browser netdev; the page
      // implements the network (src/net/). Only `-nic` can attach a backend
      // to a sysbus NIC.
      '-nic',
      'browser,model=stellaris',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    kernelFsPath: '/pack/zephyr.elf',
    peripherals: {
      gnss: true,
      hostSensor: true,
      hostGpio: true,
      hostAudio: true,
      hostMic: true,
      hostNet: true,
    },
    samples: CORTEX_M3_SAMPLES,
    // The shell is the one worth landing on: it is interactive, and it is where
    // the host-sensor bridge is visible.
    defaultSampleId: 'shell',
    usesDataBundle: false,
  },
  {
    id: 'qemu_cortex_a53',
    label: 'QEMU Cortex-A53',
    zephyrTarget: 'qemu_cortex_a53',
    arch: 'ARMv8-A',
    qemuBinary: 'qemu-system-aarch64',
    args: [
      '-nographic',
      '-machine',
      'virt,secure=on,gic-version=3',
      '-cpu',
      'cortex-a53',
      '-device',
      'ramfb',
      '-vga',
      'none',
      '-L',
      '/pack/pc-bios',
      '-icount',
      'shift=4,align=off,sleep=on',
      '-rtc',
      'clock=vm',
      // Zephyr's virtio-mmio driver only speaks modern (v2) transports.
      '-global',
      'virtio-mmio.force-legacy=false',
      // Ethernet: virtio-net on the first virtio-mmio slot, backed by the
      // browser netdev (the page implements the LAN — src/net/). The MAC
      // must match the shield overlay's local-mac-address: QEMU filters
      // inbound unicast against it and the guest driver never programs it.
      '-netdev',
      'browser,id=n0',
      '-device',
      'virtio-net-device,netdev=n0,bus=virtio-mmio-bus.0,mac=02:00:00:00:00:01',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    kernelFsPath: '/pack/zephyr.elf',
    peripherals: {
      gnss: true,
      hostSensor: true,
      hostAudio: true,
      hostMic: true,
      ramfb: true,
      // The only board started with -icount, so the only one whose guest
      // instruction counter advances.
      perfStats: true,
      hostNet: true,
    },
    samples: CORTEX_A53_SAMPLES,
    defaultSampleId: 'display',
    extraFiles: [
      { fsPath: '/pack/pc-bios/vgabios-ramfb.bin', asset: 'vgabios-ramfb.bin' },
      { fsPath: '/pack/pc-bios/efi-virtio.rom', asset: 'efi-virtio.rom' },
    ],
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

/** Panels a sample wants expanded on boot; empty when it is terminal-only. */
export function samplePrimaryPanels(board: Board, sampleId: string): Set<PanelKind> {
  return new Set(getSample(board, sampleId).primaryPanels)
}

/** Where a board's prebuilt image lives under public/qemu/. */
export function sampleAsset(board: Board, sampleId: string): string {
  return `zephyr/${board.zephyrTarget}/${sampleId}.elf`
}
