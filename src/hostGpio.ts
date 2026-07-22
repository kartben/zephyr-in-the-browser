/**
 * Browser end of the `qemu,host-gpio` bridge.
 *
 * The QEMU device exposes two entry points: `qemu_host_gpio_set_inputs(mask)`
 * writes the input pins the guest reads, and `qemu_host_gpio_get_outputs()`
 * returns the output pins the guest drives. Both act on memory shared with the
 * pthread QEMU runs on, so setting an input is a plain call and reading the
 * outputs never enters the guest.
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
}

let exports: GpioExports | null = null
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
  exports = mod as GpioExports
  if (available()) {
    // Push the seeded input state so the guest reads something defined, then
    // start pulling outputs. 100 ms is imperceptible for a blinking LED yet
    // costs almost nothing — the read is a single shared-memory load.
    exports?._qemu_host_gpio_set_inputs?.(inputs)
    poll()
    poller = setInterval(poll, 100)
  }
  notify()
}

export function detach() {
  if (poller !== undefined) clearInterval(poller)
  poller = undefined
  exports = null
  outputs = 0
  notify()
}

export function available(): boolean {
  return (
    typeof exports?._qemu_host_gpio_set_inputs === 'function' &&
    typeof exports?._qemu_host_gpio_get_outputs === 'function'
  )
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
  exports?._qemu_host_gpio_set_inputs?.(inputs)
  notify()
}

export function toggleInput(pin: number) {
  setInput(pin, !isInputHigh(pin))
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function poll() {
  const next = exports?._qemu_host_gpio_get_outputs?.() ?? 0
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
