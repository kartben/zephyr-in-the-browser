/**
 * TI LP5562 4-channel RGBW LED driver — page-side I²C model.
 *
 * Matches Zephyr's `drivers/led/lp5562.c`: direct PWM registers, LED_MAP
 * source select, ENABLE chip/engine bits, and enough engine program memory
 * for `led_blink` patterns the stock `samples/drivers/led/lp5562` loads.
 * LED indices match the sample: B=0, G=1, R=2, W=3.
 */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import lp5562Map from './maps/lp5562.json'

const REG_ENABLE = 0x00
const REG_B_PWM = 0x02
const REG_G_PWM = 0x03
const REG_R_PWM = 0x04
const REG_B_CURRENT = 0x05
const REG_G_CURRENT = 0x06
const REG_R_CURRENT = 0x07
const REG_RESET = 0x0d
const REG_W_PWM = 0x0e
const REG_W_CURRENT = 0x0f
const REG_PROG1 = 0x10
const REG_PROG2 = 0x30
const REG_PROG3 = 0x50
const REG_LED_MAP = 0x70

const CHIP_EN = 1 << 6
const RESET_MAGIC = 0xff
const SRC_PWM = 0
const ENGINE_RUN = 0x02
const SET_PWM_MSB = 1 << 6

const PWM_REGS = [REG_B_PWM, REG_G_PWM, REG_R_PWM, REG_W_PWM] as const

const LP5562_REGISTERS = registersFromJson(lp5562Map as RegisterMapJson)

export type Lp5562Channel = 'B' | 'G' | 'R' | 'W'

export interface Lp5562Options {
  address?: number
  name?: string
}

export interface Lp5562Chip extends I2cChip {
  readonly registers: readonly RegisterDecl[]
  readonly channelCount: 4
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  /** Chip ENABLE.CHIP_EN is set. */
  isChipEnabled(): boolean
  /** Effective 0…255 PWM for LED index (0=B … 3=W), including blink phase. */
  getChannelPwm(index: number): number
  /** RGBW triple for the dock orb (W folded into luminance). */
  getRgb(): { r: number; g: number; b: number; w: number }
  version(): number
  subscribe(fn: () => void): () => void
}

export function isLp5562(chip: I2cChip | null | undefined): chip is Lp5562Chip {
  return (
    !!chip &&
    typeof (chip as Lp5562Chip).getChannelPwm === 'function' &&
    typeof (chip as Lp5562Chip).getRgb === 'function' &&
    (chip as Lp5562Chip).channelCount === 4 &&
    // LP50xx also exposes getRgb + a count; it uses moduleCount instead.
    !('moduleCount' in chip) &&
    Array.isArray((chip as Lp5562Chip).registers)
  )
}

function progBase(engine: 1 | 2 | 3): number {
  if (engine === 1) return REG_PROG1
  if (engine === 2) return REG_PROG2
  return REG_PROG3
}

export function createLp5562({
  address = 0x30,
  name = 'LP5562 RGBW LED',
}: Lp5562Options = {}): Lp5562Chip {
  const mem = new Uint8Array(0x80)
  const listeners = new Set<() => void>()
  const byAddr = new Map(LP5562_REGISTERS.map((r) => [r.addr, r]))

  // Power-on-ish defaults matching DT current defaults (175 → 17.5 mA).
  mem[REG_B_CURRENT] = 175
  mem[REG_G_CURRENT] = 175
  mem[REG_R_CURRENT] = 175
  mem[REG_W_CURRENT] = 175

  let pointer = 0
  let generation = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const applyDefaults = () => {
    mem.fill(0)
    mem[REG_B_CURRENT] = 175
    mem[REG_G_CURRENT] = 175
    mem[REG_R_CURRENT] = 175
    mem[REG_W_CURRENT] = 175
  }

  const peek = (addr: number): number => mem[addr & 0x7f] ?? 0

  const pokeRaw = (addr: number, value: number) => {
    const a = addr & 0x7f
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

  /** LED_MAP source bits for channel index 0…3 → 0=PWM, 1..3=engine. */
  const channelSource = (index: number): number => {
    const map = peek(REG_LED_MAP)
    return (map >> (index * 2)) & 0x03
  }

  /** ENABLE engine-exec field: eng1 bits5:4, eng2 3:2, eng3 1:0. */
  const engineExec = (engine: 1 | 2 | 3): number => {
    const en = peek(REG_ENABLE)
    if (engine === 1) return (en >> 4) & 0x03
    if (engine === 2) return (en >> 2) & 0x03
    return en & 0x03
  }

  /** First SET_PWM brightness in an engine program, or 0xFF if none. */
  const engineSetPwm = (engine: 1 | 2 | 3): number => {
    const base = progBase(engine)
    for (let i = 0; i < 16; i++) {
      const msb = peek(base + i * 2)
      const lsb = peek(base + i * 2 + 1)
      if (msb === 0 && lsb === 0) continue // go-to-start / empty
      if ((msb & 0xc0) === SET_PWM_MSB) return lsb
    }
    return 0xff
  }

  /**
   * Approximate blink period from the first wait (ramp with step_count=0).
   * Sample uses 500 ms on / 500 ms off → ~1000 ms period.
   */
  const engineBlinkPeriodMs = (engine: 1 | 2 | 3): number => {
    const base = progBase(engine)
    let waits = 0
    let total = 0
    for (let i = 0; i < 16 && waits < 2; i++) {
      const msb = peek(base + i * 2)
      const lsb = peek(base + i * 2 + 1)
      if (msb === 0 && lsb === 0) continue
      if ((msb & 0xc0) === SET_PWM_MSB) continue
      // Ramp/wait: step_count in lsb[6:0]; 0 ⇒ wait.
      const stepCount = lsb & 0x7f
      if (stepCount !== 0) continue
      const prescale = (msb >> 6) & 0x01
      const stepTime = msb & 0x3f
      // Driver rounds to ~16 ms/step when prescale=1; else ~0.5 ms.
      const ms = prescale ? stepTime * 16 : Math.max(1, Math.round(stepTime * 0.49))
      total += ms
      waits++
    }
    return total > 0 ? total : 1000
  }

  const getChannelPwm = (index: number): number => {
    if (index < 0 || index > 3) return 0
    if ((peek(REG_ENABLE) & CHIP_EN) === 0) return 0

    const src = channelSource(index)
    if (src === SRC_PWM) return peek(PWM_REGS[index]!)

    const engine = src as 1 | 2 | 3
    if (engineExec(engine) !== ENGINE_RUN) return 0

    const brightness = engineSetPwm(engine)
    const period = engineBlinkPeriodMs(engine)
    const phase = period > 0 ? performance.now() % period : 0
    // On for the first half of the on+off wait pair (or whole period if one wait).
    const onMs = period / 2
    return phase < onMs ? brightness : 0
  }

  const getRgb = () => {
    const b = getChannelPwm(0)
    const g = getChannelPwm(1)
    const r = getChannelPwm(2)
    const w = getChannelPwm(3)
    return { r, g, b, w }
  }

  return {
    address,
    name,
    registers: LP5562_REGISTERS,
    channelCount: 4,
    peek,
    getPointer: () => pointer,
    poke(addr, value) {
      pokeRaw(addr, value)
      pointer = addr & 0x7f
    },
    setField(addr, field, value) {
      const a = addr & 0x7f
      const reg = byAddr.get(a)
      if (!reg || reg.access === 'ro') return
      pokeRaw(a, insertField(peek(a), field, value))
    },
    isChipEnabled: () => (peek(REG_ENABLE) & CHIP_EN) !== 0,
    getChannelPwm,
    getRgb,
    version: () => generation,
    write(bytes) {
      if (bytes.length === 0) return true
      pointer = bytes[0]! & 0x7f
      for (let i = 1; i < bytes.length; i++) {
        pokeRaw(pointer, bytes[i]!)
        pointer = (pointer + 1) & 0x7f
      }
      return true
    },
    read(length) {
      if (length <= 0) return new Uint8Array(0)
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        out[i] = peek(pointer)
        pointer = (pointer + 1) & 0x7f
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
