/**
 * Starchips SCT2024 16-channel LED driver — page-side SPI model.
 *
 * Matches Zephyr's `drivers/led/sct2024.c`: a 16-bit MSB-first SPI word into
 * the shift register, then a GPIO LA pulse latches it onto the LED outputs.
 * Optional OE blanks the outputs. Stock `samples/drivers/led/sct2024` walks
 * the 16 channels on/off through the LED API.
 *
 * The part is a shift-register latch, not a pointered I²C map — we still
 * expose SHIFT / LED_OUT / CTRL through the shared SVD-inspired register
 * inspector so the dock Matches every other register-file chip.
 */

import type { SpiChip, SpiTransferOpts } from '../spi'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import sct2024Map from './maps/sct2024.json'

const REG_SHIFT = 0x00
const REG_LED_OUT = 0x01
const REG_CTRL = 0x02

const CTRL_OE = 1 << 0
const CTRL_LA = 1 << 1

const LED_COUNT = 16

const SCT2024_REGISTERS = registersFromJson(sct2024Map as RegisterMapJson)

export interface Sct2024Gpio {
  getOutputs(): number
  subscribe(fn: () => void): () => void
}

export interface Sct2024GpioPins {
  /** Virtio-GPIO line for LA (required by the Zephyr driver). */
  la: number
  /**
   * Virtio-GPIO line for OE. Omit when the DT leaves `oe-gpios` unset —
   * outputs stay enabled.
   */
  oe?: number
  /** Match DT GPIO_ACTIVE_LOW on la-gpios (sample overlay does). */
  laActiveLow?: boolean
  /** Match DT GPIO_ACTIVE_LOW on oe-gpios when present. */
  oeActiveLow?: boolean
}

export interface Sct2024Options {
  cs?: number
  name?: string
}

export interface Sct2024Chip extends SpiChip {
  /** Chip-select, also used as {@link RegisterMapSource.address}. */
  readonly address: number
  readonly registers: readonly RegisterDecl[]
  readonly ledCount: typeof LED_COUNT
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  /** Effective output: LED_OUT bit set and OE enabled. */
  isLedOn(index: number): boolean
  /** Latched bitmap masked by OE (0 when blanked). */
  getBitmap(): number
  /** Wire LA/OE to a virtio-gpio controller. */
  bindGpio(gpio: Sct2024Gpio, pins: Sct2024GpioPins): () => void
  version(): number
  subscribe(fn: () => void): () => void
}

export function isSct2024(chip: SpiChip | null | undefined): chip is Sct2024Chip {
  return (
    !!chip &&
    typeof (chip as Sct2024Chip).isLedOn === 'function' &&
    typeof (chip as Sct2024Chip).getBitmap === 'function' &&
    (chip as Sct2024Chip).ledCount === LED_COUNT &&
    Array.isArray((chip as Sct2024Chip).registers)
  )
}

export function createSct2024({
  cs = 0,
  name = 'SCT2024 LED',
}: Sct2024Options = {}): Sct2024Chip {
  let shift = 0
  let ledOut = 0
  let ctrl = CTRL_OE // OE enabled until a blanking OE pin says otherwise
  let pointer = REG_SHIFT
  let generation = 0
  let gpioBound = false
  let prevLaLogical = false

  const listeners = new Set<() => void>()
  const byAddr = new Map(SCT2024_REGISTERS.map((r) => [r.addr, r]))

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const peek = (addr: number): number => {
    if (addr === REG_SHIFT) return shift & 0xffff
    if (addr === REG_LED_OUT) return ledOut & 0xffff
    if (addr === REG_CTRL) return ctrl & 0xff
    return 0
  }

  const latch = () => {
    if (ledOut === shift) return
    ledOut = shift & 0xffff
    notify()
  }

  const setCtrlBit = (mask: number, on: boolean) => {
    const next = on ? ctrl | mask : ctrl & ~mask
    if (next === ctrl) return
    ctrl = next
    notify()
  }

  const pokeRaw = (addr: number, value: number) => {
    const reg = byAddr.get(addr)
    if (reg?.access === 'ro') return

    if (addr === REG_SHIFT) {
      const next = value & 0xffff
      if (next === shift) return
      shift = next
      // No GPIO in unit tests — latch immediately so poke feels live.
      if (!gpioBound) {
        ledOut = shift
      }
      notify()
      return
    }

    if (addr === REG_LED_OUT) {
      const next = value & 0xffff
      if (next === ledOut) return
      ledOut = next
      notify()
      return
    }

    if (addr === REG_CTRL) {
      const next = value & 0xff
      const wasLa = (ctrl & CTRL_LA) !== 0
      const nowLa = (next & CTRL_LA) !== 0
      ctrl = next
      // Rising LA in the register map also latches, mirroring the GPIO path.
      if (!wasLa && nowLa) {
        ledOut = shift & 0xffff
      }
      notify()
      return
    }
  }

  const syncGpio = (
    outputs: number,
    pins: Required<Pick<Sct2024GpioPins, 'la'>> & Sct2024GpioPins,
  ) => {
    const laActiveLow = pins.laActiveLow ?? true
    const oeActiveLow = pins.oeActiveLow ?? true
    const laPhysical = ((outputs >> pins.la) & 1) !== 0
    const laLogical = laActiveLow ? !laPhysical : laPhysical

    if (pins.oe !== undefined) {
      const oePhysical = ((outputs >> pins.oe) & 1) !== 0
      const oeLogical = oeActiveLow ? !oePhysical : oePhysical
      setCtrlBit(CTRL_OE, oeLogical)
    }

    const laRose = !prevLaLogical && laLogical
    prevLaLogical = laLogical
    setCtrlBit(CTRL_LA, laLogical)
    if (laRose) latch()
  }

  return {
    cs,
    address: cs,
    name,
    registers: SCT2024_REGISTERS,
    ledCount: LED_COUNT,
    peek,
    getPointer: () => pointer,
    poke(addr, value) {
      pokeRaw(addr, value)
      pointer = addr
    },
    setField(addr, field, value) {
      const reg = byAddr.get(addr)
      if (!reg || reg.access === 'ro') return
      pokeRaw(addr, insertField(peek(addr), field, value))
      pointer = addr
    },
    isLedOn(index) {
      if (index < 0 || index >= LED_COUNT) return false
      if ((ctrl & CTRL_OE) === 0) return false
      return (ledOut & (1 << index)) !== 0
    },
    getBitmap() {
      if ((ctrl & CTRL_OE) === 0) return 0
      return ledOut & 0xffff
    },
    bindGpio(gpio, pins) {
      gpioBound = true
      prevLaLogical = false
      const refresh = () => syncGpio(gpio.getOutputs(), pins)
      refresh()
      const unsub = gpio.subscribe(refresh)
      return () => {
        unsub()
        gpioBound = false
      }
    },
    version: () => generation,
    transfer(tx: Uint8Array, _rx: Uint8Array, _opts: SpiTransferOpts) {
      // Driver writes exactly 2 bytes per chip; reject empty / odd junk.
      if (tx.length < 2) return false
      shift = ((tx[0]! << 8) | tx[1]!) & 0xffff
      // Without a LA GPIO (tests / attach-without-snippet), latch on write so
      // the LEDs still move. With GPIO bound, wait for the driver's LA pulse.
      if (!gpioBound) {
        ledOut = shift
      }
      pointer = REG_SHIFT
      notify()
      return true
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

export const sct2024Meta = {
  LED_COUNT,
  REG_SHIFT,
  REG_LED_OUT,
  REG_CTRL,
  CTRL_OE,
  CTRL_LA,
}
