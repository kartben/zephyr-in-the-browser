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
import type { BuzzerPin, SevenSegDisplay, StepperAxis } from '@/dts'
import {
  HOST_POLL_MS,
  isRegistered,
  register as registerPoll,
  unregister as unregisterPoll,
} from '@/hostPoll'
import { gpioModel, isBound, subscribeBinds } from '@/virtio'

/** Pin roles. Must match the ngpios and wiring the guest overlay declares. */
export interface Pin {
  id: number
  label: string
  /** DT flags when known; 0 = ACTIVE_HIGH with no pull/drive extras. */
  flags: number
}

export type { BuzzerPin, SevenSegDisplay, StepperAxis }

export type PinDirection = 'in' | 'out' | 'none'

export type PinConsumerKind = 'keys' | 'leds' | 'buzzer' | 'stepper' | 'seven-seg'

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
  steppers: StepperAxis[]
  sevenSegs: SevenSegDisplay[]
  node: string | null
  ngpios: number
} = {
  buttons: FALLBACK_BUTTONS,
  leds: FALLBACK_LEDS,
  buzzers: [],
  steppers: [],
  sevenSegs: [],
  node: null,
  ngpios: 8,
}

/** Default MMIO output poll. Steppers need a faster tick to catch STEP edges. */
const POLL_ID = 'gpio-mmio'
const MMIO_POLL_MS = HOST_POLL_MS
const MMIO_POLL_STEPPER_MS = 1

function pinMask(ngpios: number): number {
  if (ngpios >= 32) return 0xffffffff
  if (ngpios <= 0) return 0
  return (1 << ngpios) - 1
}

function mmioPollMs(): number {
  // Steppers need 1 ms on the MMIO path. Seven-seg also multiplexes, but on
  // virtio every SET_VALUE notifies synchronously — do not put a 1 ms timer
  // on the main thread just for the LED panel (see hostGpio subscribeOutputs).
  return derived.steppers.length > 0 ? MMIO_POLL_STEPPER_MS : MMIO_POLL_MS
}

function recomputeDerived() {
  const bridged = getDeviceTree()?.insights?.gpioControllers.find((c) => c.bridged)
  derived = bridged
    ? {
        buttons: bridged.buttons,
        leds: bridged.leds,
        buzzers: bridged.buzzers,
        steppers: bridged.steppers,
        sevenSegs: bridged.sevenSegs,
        node: bridged.controllerLabel,
        ngpios: bridged.ngpios ?? 8,
      }
    : {
        buttons: FALLBACK_BUTTONS,
        leds: FALLBACK_LEDS,
        buzzers: [],
        steppers: [],
        sevenSegs: [],
        node: null,
        ngpios: 8,
      }
  restartMmioPoller()
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

/** Step/dir steppers whose STEP pin is on the bridged controller. */
export function getSteppers(): StepperAxis[] {
  return derived.steppers
}

/** gpio-7-segment displays whose digit commons are on the bridged controller. */
export function getSevenSegs(): SevenSegDisplay[] {
  return derived.sevenSegs
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
  if (
    derived.leds.some((p) => p.id === pin) ||
    derived.buzzers.some((p) => p.id === pin) ||
    derived.steppers.some((s) => s.stepPin === pin || s.dirPin === pin) ||
    derived.sevenSegs.some(
      (d) =>
        d.digits.some((p) => p.id === pin) || d.segments.some((p) => p.id === pin),
    )
  ) {
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
  for (const axis of derived.steppers) {
    claim(
      axis.stepPin,
      { kind: 'stepper', label: `${axis.label} STEP` },
      axis.stepActiveHigh ? 0 : 1,
      'out',
    )
    claim(
      axis.dirPin,
      { kind: 'stepper', label: `${axis.label} DIR` },
      axis.dirActiveHigh ? 0 : 1,
      'out',
    )
  }
  for (const disp of derived.sevenSegs) {
    for (const [i, seg] of disp.segments.entries()) {
      const name = i < 7 ? 'ABCDEFG'[i]! : 'DP'
      claim(seg.id, { kind: 'seven-seg', label: `${disp.label} ${name}` }, seg.activeHigh ? 0 : 1, 'out')
    }
    for (const [i, dig] of disp.digits.entries()) {
      claim(
        dig.id,
        { kind: 'seven-seg', label: `${disp.label} DIG${i + 1}` },
        dig.activeHigh ? 0 : 1,
        'out',
      )
    }
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
/** Dedicated timer for the stepper 1 ms path; slow path uses hostPoll. */
let fastPoller: ReturnType<typeof setInterval> | undefined
let pollerMs = 0
let unsubscribeModel: (() => void) | undefined
let unsubscribeBinds: (() => void) | undefined
/** React / dock subscribers — coalesced to one rAF so a virtio flood cannot starve the console. */
const listeners = new Set<() => void>()
/**
 * Sync observers that must see every output word (seven-seg PoV latch, step
 * edges, buzzer). Kept separate from {@link subscribe}: gpio-7-segment refresh
 * at 1 ms can deliver thousands of SET_VALUE notifies/sec, and wiring that
 * straight into useSyncExternalStore freezes the main thread (blank terminal
 * while the guest keeps talking on I²C/SPI).
 */
const outputListeners = new Set<() => void>()
let uiNotifyRaf = 0

/** What the browser is driving onto the input pins, one bit per pin. */
let inputs = 0
/** Last output word seen from the guest, one bit per pin. */
let outputs = 0

function clearMmioPoller() {
  unregisterPoll(POLL_ID)
  if (fastPoller !== undefined) clearInterval(fastPoller)
  fastPoller = undefined
  pollerMs = 0
}

function restartMmioPoller() {
  if (!mmio) {
    clearMmioPoller()
    return
  }
  const ms = mmioPollMs()
  const onShared = isRegistered(POLL_ID)
  const onFast = fastPoller !== undefined
  if (pollerMs === ms && ((ms < HOST_POLL_MS && onFast) || (ms >= HOST_POLL_MS && onShared))) {
    return
  }
  clearMmioPoller()
  pollerMs = ms
  // Steppers need sub-beat cadence; everything else rides the shared host poll.
  if (ms < HOST_POLL_MS) fastPoller = setInterval(pollMmio, ms)
  else registerPoll(POLL_ID, ms, pollMmio)
}

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
    // start pulling outputs. The shared 100 ms host poll is imperceptible for
    // a blinking LED yet costs almost nothing — the read is a single
    // shared-memory load. When a step/dir stepper is in the tree we poll at
    // 1 ms so STEP edges are not lost on the MMIO path (virtio notifies on
    // every write instead).
    mmio.setInputs(inputs)
    pollMmio()
    restartMmioPoller()
  } else {
    unsubscribeBinds = subscribeBinds(notifyUi)
    unsubscribeModel = gpioModel.subscribe(() => {
      outputs = gpioModel.getOutputs() & pinMask(derived.ngpios)
      notifyOutputs()
      // The model's config (ngpio) may not have been known yet the moment(s)
      // this module last called setInputs — attachConfig notifies once it
      // lands, specifically so the real intended word (kept here, not
      // reconstructable from inside the model) can be re-applied. A no-op
      // once the two are already in sync.
      gpioModel.setInputs(inputs)
    })
    gpioModel.setInputs(inputs)
  }
  notifyUi()
}

export function detach() {
  clearMmioPoller()
  unsubscribeModel?.()
  unsubscribeModel = undefined
  unsubscribeBinds?.()
  unsubscribeBinds = undefined
  mmio = null
  outputs = 0
  notifyOutputs()
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
  notifyUi()
}

/**
 * UI subscription. Notifies at most once per animation frame so React panels
 * cannot be driven at virtio SET_VALUE rate.
 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Every output-word change, synchronously. For host-side models that latch or
 * count edges; do not put React setState here.
 */
export function subscribeOutputs(fn: () => void): () => void {
  outputListeners.add(fn)
  return () => outputListeners.delete(fn)
}

function pollMmio() {
  const next = mmio?.getOutputs() ?? 0
  const masked = next & pinMask(derived.ngpios)
  if (masked === outputs) return
  outputs = masked
  notifyOutputs()
}

function notifyOutputs() {
  for (const fn of outputListeners) fn()
  notifyUi()
}

function notifyUi() {
  if (uiNotifyRaf !== 0) return
  uiNotifyRaf = requestAnimationFrame(() => {
    uiNotifyRaf = 0
    for (const fn of listeners) fn()
  })
}

// A devicetree can arrive at any point (sample fetch, user drop, startup
// claim); re-derive the pin lists and wake the panel whenever it does.
recomputeDerived()
subscribeDeviceTree(() => {
  recomputeDerived()
  notifyUi()
})
