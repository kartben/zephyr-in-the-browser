/**
 * Browser GPIO facade for both backends: Cortex-M3's `qemu,host-gpio` MMIO
 * exports and Cortex-A53's TypeScript virtio-gpio model. Kept outside the
 * PtyBackend seam because either bridge may be absent.
 */

import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import type { BuzzerPin } from '@/dts'
import { gpioModel, isBound, subscribeBinds } from '@/virtio'

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

// Unknown devicetrees fall back to host-gpio's wiring: pins 0-3 are browser
// inputs and pins 4-7 are guest outputs. A loaded zephyr.dts overrides this.
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

// Cached because getButtons/getLeds are useSyncExternalStore snapshots; return
// the same reference until wiring actually changes.
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

export function getButtons(): Pin[] {
  return derived.buttons
}

export function getLeds(): Pin[] {
  return derived.leds
}

export function getBuzzers(): BuzzerPin[] {
  return derived.buzzers
}

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

let inputs = 0
let outputs = 0

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

export function isBuzzerOn(buzzer: BuzzerPin): boolean {
  const high = isOutputHigh(buzzer.id)
  return buzzer.activeHigh ? high : !high
}

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
