/**
 * TI LP50xx RGB LED drivers — page-side I²C model (LP5012 first).
 *
 * Matches Zephyr's `drivers/led/lp50xx.c` for the 4-module chipset
 * (LP5009/LP5012): DEVICE_CONFIG*, bank regs, per-LED brightness, OUT colors,
 * and RESET. LED color order follows the stock sample's R,G,B mapping.
 * Address 0x14 avoids the LP5562 at 0x30.
 */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import lp5012Map from './maps/lp5012.json'

const REG_CONFIG0 = 0x00
const REG_CONFIG1 = 0x01
const REG_LED0_BRIGHTNESS = 0x07
const REG_OUT0_COLOR = 0x0b
const REG_RESET = 0x17

const CHIP_EN = 1 << 6
const LED_GLOBAL_OFF = 1 << 0
const RESET_MAGIC = 0xff
const COLORS_PER_LED = 3
const MODULE_COUNT = 4

const LP5012_REGISTERS = registersFromJson(lp5012Map as RegisterMapJson)

export interface Rgbw {
  r: number
  g: number
  b: number
  w: number
}

export interface Lp50xxOptions {
  address?: number
  name?: string
  /** How many RGB modules the dock paints (≤4 for LP5012). */
  moduleCount?: number
}

export interface Lp50xxChip extends I2cChip {
  readonly registers: readonly RegisterDecl[]
  /** Distinguishes from LP5562's channelCount duck-type. */
  readonly moduleCount: number
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  isChipEnabled(): boolean
  /** Effective RGBW for module index (brightness × color). */
  getModuleRgb(index: number): Rgbw
  /** Brightest module — badge / single-orb fallback. */
  getRgb(): Rgbw
  version(): number
  subscribe(fn: () => void): () => void
}

export function isLp50xx(chip: I2cChip | null | undefined): chip is Lp50xxChip {
  return (
    !!chip &&
    typeof (chip as Lp50xxChip).getModuleRgb === 'function' &&
    typeof (chip as Lp50xxChip).getRgb === 'function' &&
    typeof (chip as Lp50xxChip).moduleCount === 'number' &&
    Array.isArray((chip as Lp50xxChip).registers)
  )
}

export function createLp5012({
  address = 0x14,
  name = 'LP5012 RGB LED',
  moduleCount = MODULE_COUNT,
}: Lp50xxOptions = {}): Lp50xxChip {
  const modules = Math.max(1, Math.min(MODULE_COUNT, moduleCount))
  const mem = new Uint8Array(0x40)
  const listeners = new Set<() => void>()
  const byAddr = new Map(LP5012_REGISTERS.map((r) => [r.addr, r]))

  let pointer = 0
  let generation = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const applyDefaults = () => {
    mem.fill(0)
  }

  const peek = (addr: number): number => mem[addr & 0x3f] ?? 0

  const pokeRaw = (addr: number, value: number) => {
    const a = addr & 0x3f
    const reg = byAddr.get(a)
    if (reg?.access === 'ro') return

    if (a === REG_RESET && (value & 0xff) === RESET_MAGIC) {
      applyDefaults()
      notify()
      return
    }

    mem[a] = value & 0xff
    notify()
  }

  const scale = (color: number, brightness: number): number =>
    Math.round((color * brightness) / 255) & 0xff

  const getModuleRgb = (index: number): Rgbw => {
    if (index < 0 || index >= modules) return { r: 0, g: 0, b: 0, w: 0 }
    if ((peek(REG_CONFIG0) & CHIP_EN) === 0) return { r: 0, g: 0, b: 0, w: 0 }
    if ((peek(REG_CONFIG1) & LED_GLOBAL_OFF) !== 0) return { r: 0, g: 0, b: 0, w: 0 }

    const brightness = peek(REG_LED0_BRIGHTNESS + index)
    const base = REG_OUT0_COLOR + index * COLORS_PER_LED
    // Stock sample color-mapping is R, G, B → OUT order.
    return {
      r: scale(peek(base), brightness),
      g: scale(peek(base + 1), brightness),
      b: scale(peek(base + 2), brightness),
      w: 0,
    }
  }

  const getRgb = (): Rgbw => {
    let best: Rgbw = { r: 0, g: 0, b: 0, w: 0 }
    let bestSum = -1
    for (let i = 0; i < modules; i++) {
      const rgb = getModuleRgb(i)
      const sum = rgb.r + rgb.g + rgb.b
      if (sum > bestSum) {
        best = rgb
        bestSum = sum
      }
    }
    return best
  }

  return {
    address,
    name,
    registers: LP5012_REGISTERS,
    moduleCount: modules,
    peek,
    getPointer: () => pointer,
    poke(addr, value) {
      pokeRaw(addr, value)
      pointer = addr & 0x3f
    },
    setField(addr, field, value) {
      const a = addr & 0x3f
      const reg = byAddr.get(a)
      if (!reg || reg.access === 'ro') return
      pokeRaw(a, insertField(peek(a), field, value))
    },
    isChipEnabled: () => (peek(REG_CONFIG0) & CHIP_EN) !== 0,
    getModuleRgb,
    getRgb,
    version: () => generation,
    write(bytes) {
      if (bytes.length === 0) return true
      pointer = bytes[0]! & 0x3f
      for (let i = 1; i < bytes.length; i++) {
        pokeRaw(pointer, bytes[i]!)
        pointer = (pointer + 1) & 0x3f
      }
      return true
    },
    read(length) {
      if (length <= 0) return new Uint8Array(0)
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        out[i] = peek(pointer)
        pointer = (pointer + 1) & 0x3f
      }
      return out
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
