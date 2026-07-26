/** PCA9685 16-ch PWM I²C model (MODE1/2, LEDn_ON/OFF, PRE_SCALE). */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { PwmChannel, PwmChip, PwmDecl } from '../pwm/model'
import pca9685Map from './maps/pca9685.json'

const CHANNEL_CNT = 16
const PWM_STEPS = 4096
const OSC_HZ = 25_000_000
const ADDR_MODE1 = 0x00
const ADDR_MODE2 = 0x01
const ADDR_LED0_ON_L = 0x06
const ADDR_PRE_SCALE = 0xfe
const LED_FULL = 0x10
const MODE1_SLEEP = 0x10
const MODE1_AI = 0x20
const MODE2_OUTDRV = 0x04
const PRE_SCALE_DEFAULT = 0x1e

const PCA9685_REGISTERS = registersFromJson(pca9685Map as RegisterMapJson)

const DECL: PwmDecl = {
  name: 'PCA9685',
  channelCount: CHANNEL_CNT,
  periodScope: 'controller',
  detailKeys: ['prescale', 'drive'],
}

export interface Pca9685Options {
  address?: number
  name?: string
}

export interface Pca9685Chip extends PwmChip {
  getPreScale(): number
  getFrequencyHz(): number
}

export function isPca9685(chip: I2cChip | null | undefined): chip is Pca9685Chip {
  return (
    !!chip &&
    typeof (chip as Pca9685Chip).getPreScale === 'function' &&
    typeof (chip as Pca9685Chip).getFrequencyHz === 'function' &&
    (chip as Pca9685Chip).decl?.name === 'PCA9685'
  )
}

function ledOnL(n: number): number {
  return ADDR_LED0_ON_L + 4 * n
}

function periodNsFromPreScale(preScale: number): number {
  return (1e9 * PWM_STEPS * (preScale + 1)) / OSC_HZ
}

export function createPca9685({
  address = 0x60,
  name = 'PCA9685 PWM',
}: Pca9685Options = {}): Pca9685Chip {
  const mem = new Uint8Array(256)
  const listeners = new Set<() => void>()
  const byAddr = new Map(PCA9685_REGISTERS.map((r) => [r.addr, r]))

  // Datasheet / driver defaults
  mem[ADDR_MODE1] = MODE1_AI
  mem[ADDR_MODE2] = MODE2_OUTDRV // totem-pole
  mem[ADDR_PRE_SCALE] = PRE_SCALE_DEFAULT
  for (let n = 0; n < CHANNEL_CNT; n++) {
    mem[ledOnL(n) + 3] = LED_FULL // full-off at reset
  }

  let pointer = 0
  let generation = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const peek = (addr: number): number => mem[addr & 0xff]!

  /** Write one register byte. Returns true when mem changed. Caller notifies. */
  const writeByte = (addr: number, value: number): boolean => {
    const a = addr & 0xff
    const reg = byAddr.get(a)
    if (reg?.access === 'ro') return false
    const v = value & 0xff
    // PRE_SCALE is only writable while SLEEP is set (datasheet / Zephyr).
    if (a === ADDR_PRE_SCALE && (mem[ADDR_MODE1]! & MODE1_SLEEP) === 0) return false
    if (mem[a] === v) return false
    mem[a] = v
    return true
  }

  /**
   * One I²C write can cover LEDn_ON/OFF (4 data bytes) under AUTO_INC.
   * Notify once at the end — same coalescing as HT16K33 display bursts —
   * so a fade step does not fire four React subscribers mid-register.
   */
  const applyWrite = (bytes: Uint8Array) => {
    if (bytes.length === 0) return
    pointer = bytes[0]! & 0xff
    const ai = (mem[ADDR_MODE1]! & MODE1_AI) !== 0
    let changed = false
    for (let i = 1; i < bytes.length; i++) {
      if (writeByte(pointer, bytes[i]!)) changed = true
      if (ai) pointer = (pointer + 1) & 0xff
    }
    if (changed) notify()
  }

  const getPreScale = () => mem[ADDR_PRE_SCALE]! & 0xff

  const getChannel = (index: number): PwmChannel => {
    const n = Math.max(0, Math.min(CHANNEL_CNT - 1, index | 0))
    const base = ledOnL(n)
    const onL = mem[base]!
    const onH = mem[base + 1]!
    const offL = mem[base + 2]!
    const offH = mem[base + 3]!
    const fullOn = (onH & LED_FULL) !== 0
    const fullOff = (offH & LED_FULL) !== 0
    const on = ((onH & 0x0f) << 8) | onL
    const off = ((offH & 0x0f) << 8) | offL
    const periodNs = periodNsFromPreScale(getPreScale())

    if (fullOff) {
      return {
        index: n,
        duty: 0,
        periodNs,
        pulseNs: 0,
        fullOn: false,
        fullOff: true,
        inverted: false,
      }
    }
    if (fullOn) {
      return {
        index: n,
        duty: 1,
        periodNs,
        pulseNs: periodNs,
        fullOn: true,
        fullOff: false,
        inverted: false,
      }
    }

    let steps = off - on
    if (steps < 0) steps += PWM_STEPS
    steps = Math.min(PWM_STEPS, Math.max(0, steps))
    const duty = steps / PWM_STEPS
    return {
      index: n,
      duty,
      periodNs,
      pulseNs: periodNs * duty,
      fullOn: false,
      fullOff: false,
      inverted: false,
    }
  }

  return {
    address,
    name,
    decl: DECL,
    registers: PCA9685_REGISTERS,
    peek,
    getPointer: () => pointer,
    poke(addr, value) {
      // Allow UI / tests to poke PRE_SCALE without SLEEP dance.
      if ((addr & 0xff) === ADDR_PRE_SCALE) {
        const v = value & 0xff
        if (mem[ADDR_PRE_SCALE] !== v) {
          mem[ADDR_PRE_SCALE] = v
          notify()
        }
        return
      }
      if (writeByte(addr, value)) notify()
    },
    setField(addr, field, value) {
      const reg = byAddr.get(addr & 0xff)
      if (!reg || reg.access === 'ro') return
      const next = insertField(peek(addr), field, value)
      if ((addr & 0xff) === ADDR_PRE_SCALE) {
        const v = next & 0xff
        if (mem[ADDR_PRE_SCALE] !== v) {
          mem[ADDR_PRE_SCALE] = v
          notify()
        }
        return
      }
      if (writeByte(addr, next)) notify()
    },
    getPreScale,
    getFrequencyHz() {
      return OSC_HZ / (PWM_STEPS * (getPreScale() + 1))
    },
    getChannel,
    getDetail(key) {
      if (key === 'prescale') {
        const ps = getPreScale()
        return `0x${ps.toString(16).padStart(2, '0').toUpperCase()}`
      }
      if (key === 'drive') {
        return (mem[ADDR_MODE2]! & MODE2_OUTDRV) !== 0 ? 'totem-pole' : 'open-drain'
      }
      return ''
    },
    version: () => generation,
    write(bytes) {
      applyWrite(bytes)
      return true
    },
    read(length) {
      if (length <= 0) return new Uint8Array(0)
      const ai = (mem[ADDR_MODE1]! & MODE1_AI) !== 0
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        out[i] = peek(pointer)
        if (ai) pointer = (pointer + 1) & 0xff
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