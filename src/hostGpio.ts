/**
 * Browser end of the GPIO bridge.
 *
 * Two QEMU devices land here, one per board, and they present the same pair of
 * entry points: `*_set_inputs(mask)` writes the input pins the guest reads, and
 * `*_get_outputs()` returns the output pins the guest drives.
 *
 * - `qemu_host_gpio_*` — the Cortex-M3's qemu,host-gpio, a small MMIO register
 *   block. A guest read is a single load that never leaves the guest.
 * - `qemu_virtio_gpio_*` — the Cortex-A53's standard VIRTIO GPIO device, which
 *   a stock Zephyr driver speaks to. Every guest operation is a virtqueue round
 *   trip, but the device has a real interrupt path, so buttons wake the guest
 *   instead of being polled by it.
 *
 * The difference is entirely on the far side of the wires: both act on memory
 * shared with the pthread QEMU runs on, so setting an input is a plain call and
 * reading the outputs never enters the guest. Which is why one panel drives
 * both, and this module only has to pick whichever pair the build exports.
 *
 * Inputs are push (a button click updates the whole word immediately); outputs
 * are pull (the guest changes them whenever it likes, so we poll on an interval
 * and notify when the word changes). Deliberately not part of the PtyBackend
 * seam: the bridge is optional, and a backend with no GPIO device need not know
 * it exists.
 */

/** Pin roles. Must match the ngpios and wiring the guest overlay declares. */
export interface Pin {
  id: number
  label: string
}

/** Pins 0-3 are inputs the browser drives; 4-7 are outputs the guest drives. */
export const BUTTONS: Pin[] = [
  { id: 0, label: 'SW0' },
  { id: 1, label: 'SW1' },
  { id: 2, label: 'SW2' },
  { id: 3, label: 'SW3' },
]

export const LEDS: Pin[] = [
  { id: 4, label: 'LED0' },
  { id: 5, label: 'LED1' },
  { id: 6, label: 'LED2' },
  { id: 7, label: 'LED3' },
]

interface GpioExports {
  _qemu_host_gpio_set_inputs?: (mask: number) => void
  _qemu_host_gpio_get_outputs?: () => number
  _qemu_virtio_gpio_set_inputs?: (mask: number) => void
  _qemu_virtio_gpio_get_outputs?: () => number
}

/** The entry-point pair actually found in the module, or null if it has none. */
interface GpioBridge {
  setInputs: (mask: number) => void
  getOutputs: () => number
  /** Devicetree label of the controller, for the panel's shell hint. */
  node: string
}

/**
 * Prefer the MMIO device where both exist. Only one is ever wired up on a given
 * machine, but the emulator artifact is per-architecture rather than per-board,
 * so a build can export both sets of symbols.
 */
function bind(mod: GpioExports | null): GpioBridge | null {
  if (typeof mod?._qemu_host_gpio_set_inputs === 'function' &&
      typeof mod._qemu_host_gpio_get_outputs === 'function') {
    return {
      setInputs: mod._qemu_host_gpio_set_inputs,
      getOutputs: mod._qemu_host_gpio_get_outputs,
      node: 'host_gpio',
    }
  }
  if (typeof mod?._qemu_virtio_gpio_set_inputs === 'function' &&
      typeof mod._qemu_virtio_gpio_get_outputs === 'function') {
    return {
      setInputs: mod._qemu_virtio_gpio_set_inputs,
      getOutputs: mod._qemu_virtio_gpio_get_outputs,
      node: 'virtio_gpio0',
    }
  }
  return null
}

let bridge: GpioBridge | null = null
let poller: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

/** What the browser is driving onto the input pins, one bit per pin. */
let inputs = 0
/** Last output word read back from the guest, one bit per pin. */
let outputs = 0

/**
 * Called by the qemu backend once its module is live. A build without the
 * device patch simply lacks the exports, which `available()` reports.
 */
export function attach(mod: unknown) {
  detach()
  bridge = bind(mod as GpioExports | null)
  if (bridge) {
    // Push the seeded input state so the guest reads something defined, then
    // start pulling outputs. 100 ms is imperceptible for a blinking LED yet
    // costs almost nothing — the read is a single shared-memory load.
    bridge.setInputs(inputs)
    poll()
    poller = setInterval(poll, 100)
  }
  notify()
}

export function detach() {
  if (poller !== undefined) clearInterval(poller)
  poller = undefined
  bridge = null
  outputs = 0
  notify()
}

export function available(): boolean {
  return bridge !== null
}

/**
 * Devicetree label of the bound controller — `host_gpio` on the Cortex-M3,
 * `virtio_gpio0` on the Cortex-A53. The panel quotes it in its `gpio` shell
 * hint, which is otherwise wrong on whichever board it was not written for.
 */
export function controllerNode(): string {
  return bridge?.node ?? 'host_gpio'
}

export function getInputs(): number {
  return inputs
}

export function getOutputs(): number {
  return outputs
}

export function isInputHigh(pin: number): boolean {
  return (inputs & (1 << pin)) !== 0
}

export function isOutputHigh(pin: number): boolean {
  return (outputs & (1 << pin)) !== 0
}

/** Drive one input pin high or low and push the whole word to the device. */
export function setInput(pin: number, high: boolean) {
  const next = high ? inputs | (1 << pin) : inputs & ~(1 << pin)
  if (next === inputs) return
  inputs = next
  bridge?.setInputs(inputs)
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function poll() {
  const next = bridge?.getOutputs() ?? 0
  // The device masks to its pin count, but a guest could in principle write
  // wider; keep only the low 8 so the UI never lights a pin it doesn't show.
  const masked = next & 0xff
  if (masked === outputs) return
  outputs = masked
  notify()
}

function notify() {
  for (const fn of listeners) fn()
}
