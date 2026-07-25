/**
 * Browser end of the GPIO bridge.
 *
 * Two very different devices land here, one per board, and this module hides
 * the difference so a single panel drives both.
 *
 * - **Cortex-M3 — `qemu,host-gpio`.** A small MMIO register block in QEMU
 *   (`tools/qemu-patches/0005-*`). A guest read is a single load that never
 *   leaves the guest, and the page reaches the pins through two exported C
 *   functions. Inputs are push, outputs are pull: the guest changes them
 *   whenever it likes, so we poll on an interval. The LM3S6965 machine has no
 *   virtio-mmio bus to move onto, so it keeps this.
 *
 * - **Cortex-A53 — VIRTIO GPIO.** A standard VIRTIO GPIO controller the
 *   vendored upstream `virtio,gpio` driver binds to. The *device model* is
 *   TypeScript — `src/virtio/devices/gpio.ts`, running on the generic bridge —
 *   so nothing is polled at all: an input edge fires the guest's interrupt
 *   synchronously, and a guest-driven output notifies this module the moment
 *   it is written.
 *
 * Deliberately not part of the PtyBackend seam: the bridge is optional, and a
 * backend with no GPIO device need not know it exists.
 */

import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import type { BuzzerPin } from '@/dts'
import { gpioModel, isBound, subscribeBinds } from '@/virtio'

/** Pin roles. Must match the ngpios and wiring the guest overlay declares. */
export interface Pin {
  id: number
  label: string
  /** DT flags when known; 0 = ACTIVE_HIGH with no pull/drive extras. */
  flags: number
}

export type { BuzzerPin }

export type PinDirection = 'in' | 'out' | 'none'

export type PinConsumerKind = 'keys' | 'leds' | 'buzzer'

export interface ClaimedPin {
  id: number
  direction: PinDirection
  /** DT flags when a consumer declared them; undefined if runtime-only. */
  flags?: number
  consumer?: { kind: PinConsumerKind; label: string }
}

/**
 * The full pin fan-out of the bridge, for builds whose devicetree is unknown:
 * pins 0-3 are inputs the browser drives; 4-7 are outputs the guest drives.
 * When a zephyr.dts is loaded, the panel shows the pins its gpio-keys and
 * gpio-leds nodes actually wire instead — see getButtons/getLeds.
 */
const FALLBACK_BUTTONS: Pin[] = [
  { id: 0, label: 'SW0', flags: 0 },
  { id: 1, label: 'SW1', flags: 0 },
  { id: 2, label: 'SW2', flags: 0 },
  { id: 3, label: 'SW3', flags: 0 },
]

const FALLBACK_LEDS: Pin[] = [
  { id: 4, label: 'LED0', flags: 0 },
  { id: 5, label: 'LED1', flags: 0 },
  { id: 6, label: 'LED2', flags: 0 },
  { id: 7, label: 'LED3', flags: 0 },
]

/*
 * Pins and controller label derived from the loaded devicetree. Cached, not
 * computed per call: getButtons/getLeds are useSyncExternalStore snapshots, so
 * they must return the same reference until something actually changed.
 */
let derived: {
  buttons: Pin[]
  leds: Pin[]
  buzzers: BuzzerPin[]
  node: string | null
  ngpios: number
} = {
  buttons: FALLBACK_BUTTONS,
  leds: FALLBACK_LEDS,
  buzzers: [],
  node: null,
  ngpios: 8,
}

function recomputeDerived() {
  const bridged = getDeviceTree()?.insights?.gpioControllers.find((c) => c.bridged)
  derived = bridged
    ? {
        buttons: bridged.buttons,
        leds: bridged.leds,
        buzzers: bridged.buzzers,
        node: bridged.controllerLabel,
        ngpios: bridged.ngpios ?? 8,
      }
    : {
        buttons: FALLBACK_BUTTONS,
        leds: FALLBACK_LEDS,
        buzzers: [],
        node: null,
        ngpios: 8,
      }
}

/** What the browser drives: gpio-keys pins when a devicetree says, else 0-3. */
export function getButtons(): Pin[] {
  return derived.buttons
}

/** What the guest drives: gpio-leds pins when a devicetree says, else 4-7. */
export function getLeds(): Pin[] {
  return derived.leds
}

/** gpio-buzzer pins declared on the bridged controller (empty when none). */
export function getBuzzers(): BuzzerPin[] {
  return derived.buzzers
}

/** Controller width from DT `ngpios` (fallback 8). */
export function getNgpios(): number {
  return derived.ngpios
}

/**
 * Runtime direction for one line. Virtio exposes the guest-programmed
 * direction; MMIO host-gpio has none — infer from DT consumer role when
 * claimed, else `none`.
 */
export function getPinDirection(pin: number): PinDirection {
  if (!mmio && isBound(gpioModel.name)) {
    return gpioModel.getDirection(pin)
  }
  if (derived.buttons.some((p) => p.id === pin)) return 'in'
  if (derived.leds.some((p) => p.id === pin) || derived.buzzers.some((p) => p.id === pin)) {
    return 'out'
  }
  return 'none'
}

/**
 * Proposal B claimed pins: DT consumers and/or live IN/OUT, sorted by index.
 * Snapshot identity changes whenever derived wiring or directions change —
 * callers that need a stable subscribe token should join pin ids + dirs.
 */
export function getClaimedPins(): ClaimedPin[] {
  const byId = new Map<number, ClaimedPin>()

  const claim = (
    id: number,
    consumer: ClaimedPin['consumer'],
    flags: number | undefined,
    inferred: PinDirection,
  ) => {
    const runtime = getPinDirection(id)
    const direction = runtime !== 'none' ? runtime : inferred
    const prev = byId.get(id)
    byId.set(id, {
      id,
      direction,
      flags: flags ?? prev?.flags,
      consumer: consumer ?? prev?.consumer,
    })
  }

  for (const pin of derived.buttons) {
    claim(pin.id, { kind: 'keys', label: pin.label }, pin.flags, 'in')
  }
  for (const pin of derived.leds) {
    claim(pin.id, { kind: 'leds', label: pin.label }, pin.flags, 'out')
  }
  for (const pin of derived.buzzers) {
    claim(
      pin.id,
      { kind: 'buzzer', label: pin.label },
      pin.activeHigh ? 0 : 1,
      'out',
    )
  }

  // Runtime-only claims (guest configured a line with no DT consumer).
  const n = Math.min(derived.ngpios, 32)
  for (let id = 0; id < n; id++) {
    if (byId.has(id)) continue
    const direction = getPinDirection(id)
    if (direction === 'none') continue
    byId.set(id, { id, direction })
  }

  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/** Stable subscribe token for claimed pin dir/level changes. */
export function claimedPinsToken(): string {
  return getClaimedPins()
    .map((p) => {
      const level =
        p.direction === 'in'
          ? isInputHigh(p.id)
            ? '1'
            : '0'
          : p.direction === 'out'
            ? isOutputHigh(p.id)
              ? '1'
              : '0'
            : '-'
      return `${p.id}:${p.direction}:${level}:${p.consumer?.kind ?? ''}`
    })
    .join('|')
}

interface GpioExports {
  _qemu_host_gpio_set_inputs?: (mask: number) => void
  _qemu_host_gpio_get_outputs?: () => number
}

/** The MMIO entry-point pair, when the running build carries that device. */
interface MmioBridge {
  setInputs: (mask: number) => void
  getOutputs: () => number
}

function bindMmio(mod: GpioExports | null): MmioBridge | null {
  if (
    typeof mod?._qemu_host_gpio_set_inputs === 'function' &&
    typeof mod._qemu_host_gpio_get_outputs === 'function'
  ) {
    return {
      setInputs: mod._qemu_host_gpio_set_inputs,
      getOutputs: mod._qemu_host_gpio_get_outputs,
    }
  }
  return null
}

let mmio: MmioBridge | null = null
let poller: ReturnType<typeof setInterval> | undefined
let unsubscribeModel: (() => void) | undefined
let unsubscribeBinds: (() => void) | undefined
const listeners = new Set<() => void>()

/** What the browser is driving onto the input pins, one bit per pin. */
let inputs = 0
/** Last output word seen from the guest, one bit per pin. */
let outputs = 0

/**
 * Called by the qemu backend once its module is live. A build with neither
 * device simply binds nothing, which `available()` reports.
 *
 * The virtio path is not resolved here: the generic bridge binds its devices
 * on its first poll, which can be after this runs, so we watch for the bind
 * instead of latching the panel off.
 */
export function attach(mod: unknown) {
  detach()
  mmio = bindMmio(mod as GpioExports | null)

  if (mmio) {
    // Push the seeded input state so the guest reads something defined, then
    // start pulling outputs. 100 ms is imperceptible for a blinking LED yet
    // costs almost nothing — the read is a single shared-memory load.
    mmio.setInputs(inputs)
    pollMmio()
    poller = setInterval(pollMmio, 100)
  } else {
    unsubscribeBinds = subscribeBinds(notify)
    unsubscribeModel = gpioModel.subscribe(() => {
      outputs = gpioModel.getOutputs() & 0xff
      notify()
    })
    gpioModel.setInputs(inputs)
  }
  notify()
}

export function detach() {
  if (poller !== undefined) clearInterval(poller)
  poller = undefined
  unsubscribeModel?.()
  unsubscribeModel = undefined
  unsubscribeBinds?.()
  unsubscribeBinds = undefined
  mmio = null
  outputs = 0
  notify()
}

export function available(): boolean {
  return mmio !== null || isBound(gpioModel.name)
}

/**
 * Devicetree label of the bound controller, quoted by the panel's `gpio` shell
 * hint. The loaded devicetree names it authoritatively; without one, fall back
 * to the labels the bundled overlays use — `host_gpio` on the Cortex-M3's MMIO
 * bridge, `virtio_gpio0` on the Cortex-A53.
 */
export function controllerNode(): string {
  return derived.node ?? (mmio ? 'host_gpio' : 'virtio_gpio0')
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

/** Whether a gpio-buzzer is sounding (output matches its active level). */
export function isBuzzerOn(buzzer: BuzzerPin): boolean {
  const high = isOutputHigh(buzzer.id)
  return buzzer.activeHigh ? high : !high
}

/** Drive one input pin high or low and push the whole word to the device. */
export function setInput(pin: number, high: boolean) {
  const next = high ? inputs | (1 << pin) : inputs & ~(1 << pin)
  if (next === inputs) return
  inputs = next
  if (mmio) mmio.setInputs(inputs)
  // On the virtio path this is what raises the guest's interrupt, and it does
  // so at the instant of the edge rather than at the next sampling tick.
  else gpioModel.setInputs(inputs)
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function pollMmio() {
  const next = mmio?.getOutputs() ?? 0
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

// A devicetree can arrive at any point (sample fetch, user drop, startup
// claim); re-derive the pin lists and wake the panel whenever it does.
recomputeDerived()
subscribeDeviceTree(() => {
  recomputeDerived()
  notify()
})
