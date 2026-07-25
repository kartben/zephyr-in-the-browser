/**
 * Analog Devices / Maxim MAX17048 ModelGauge fuel gauge — page-side I²C model.
 *
 * First {@link FuelGaugeChip} provider. Matches Zephyr's
 * `drivers/fuel_gauge/max17048/max17048.c`: 16-bit big-endian register file,
 * VERSION probe `(value & 0xFFF0) == 0x0010`, VCELL / SOC / CRATE conversions.
 * Stock `samples/drivers/fuel_gauge` polls SoC % and voltage via
 * `fuel_gauge_get_props` against alias `fuel-gauge0`.
 */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import {
  estimateRuntimeMins,
  type FuelGaugeChip,
  type FuelGaugeDecl,
  type FuelGaugeReading,
} from '../fuel-gauge/model'
import max17048Map from './maps/max17048.json'

const REG_VCELL = 0x02
const REG_SOC = 0x04
const REG_MODE = 0x06
const REG_VERSION = 0x08
const REG_HIBRT = 0x0a
const REG_CONFIG = 0x0c
const REG_VALRT = 0x14
const REG_CRATE = 0x16
const REG_VRESET = 0x18
const REG_STATUS = 0x1a
const REG_COMMAND = 0xfe

const RESET_COMMAND = 0x5400
const QUICKSTART_MODE = 0x4000

/** Datasheet Table 2: 78.125 µV per VCELL LSB. */
const VCELL_UV_PER_LSB = 78.125
/** Datasheet: 0.208 %/hour per CRATE LSB. */
const CRATE_PCT_PER_LSB = 0.208

const MAX17048_REGISTERS = registersFromJson(max17048Map as RegisterMapJson)

const DECL: FuelGaugeDecl = {
  name: 'MAX17048',
  vEmptyMv: 3000,
  vFullMv: 4200,
  designCapacityMah: 1000,
  detailKeys: ['crate', 'tte', 'ttf'],
}

export interface Max17048Options {
  address?: number
  name?: string
  /** Initial SoC percent (default 75). */
  socPct?: number
  /** Initial cell voltage in millivolts (default 3700). */
  voltageMv?: number
  /** Initial charge rate in %/hour; negative = discharging (default -5). */
  cratePctPerHour?: number
}

export interface Max17048Chip extends FuelGaugeChip {
  /** Raw 16-bit register word (logical / big-endian value). */
  getReg(addr: number): number
}

export function isMax17048(chip: I2cChip | null | undefined): chip is Max17048Chip {
  return (
    !!chip &&
    typeof (chip as Max17048Chip).getReg === 'function' &&
    (chip as Max17048Chip).decl?.name === 'MAX17048'
  )
}

function socToRaw(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct))
  return Math.round(clamped * 256) & 0xffff
}

function rawToSoc(raw: number): number {
  return Math.max(0, Math.min(100, Math.floor((raw & 0xffff) / 256)))
}

function voltageMvToRaw(mv: number): number {
  const uv = Math.max(0, mv) * 1000
  return Math.round(uv / VCELL_UV_PER_LSB) & 0xffff
}

function rawToVoltageUv(raw: number): number {
  return Math.round((raw & 0xffff) * VCELL_UV_PER_LSB)
}

function crateToRaw(pctPerHour: number): number {
  let counts = Math.round(pctPerHour / CRATE_PCT_PER_LSB)
  if (counts > 32767) counts = 32767
  if (counts < -32768) counts = -32768
  return counts & 0xffff
}

function rawToCrate(raw: number): number {
  let signed = raw & 0xffff
  if (signed >= 0x8000) signed -= 0x10000
  return signed * CRATE_PCT_PER_LSB
}

function putBe16(value: number, out: Uint8Array, offset: number) {
  out[offset] = (value >> 8) & 0xff
  out[offset + 1] = value & 0xff
}

export function createMax17048({
  address = 0x36,
  name = 'MAX17048 fuel gauge',
  socPct = 75,
  voltageMv = 3700,
  cratePctPerHour = -5,
}: Max17048Options = {}): Max17048Chip {
  const decl: FuelGaugeDecl = { ...DECL }
  const listeners = new Set<() => void>()
  const byAddr = new Map(MAX17048_REGISTERS.map((r) => [r.addr, r]))

  const regs = new Map<number, number>()
  for (const r of MAX17048_REGISTERS) {
    regs.set(r.addr, r.reset & 0xffff)
  }

  let pointer = REG_VCELL
  let generation = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const applyDefaults = () => {
    regs.set(REG_VERSION, 0x0012)
    regs.set(REG_HIBRT, 0x8030)
    regs.set(REG_CONFIG, 0x971c)
    regs.set(REG_VALRT, 0x00ff)
    regs.set(REG_VRESET, 0x0096)
    regs.set(REG_STATUS, 0x0001)
    regs.set(REG_MODE, 0)
    regs.set(REG_COMMAND, 0)
    regs.set(REG_SOC, socToRaw(socPct))
    regs.set(REG_VCELL, voltageMvToRaw(voltageMv))
    regs.set(REG_CRATE, crateToRaw(cratePctPerHour))
  }
  applyDefaults()

  const peek = (addr: number): number => regs.get(addr & 0xff) ?? 0

  const writeWord = (addr: number, value: number) => {
    const a = addr & 0xff
    const reg = byAddr.get(a)
    if (!reg) return
    const word = value & 0xffff

    if (a === REG_COMMAND) {
      regs.set(REG_COMMAND, word)
      if (word === RESET_COMMAND) {
        applyDefaults()
        notify()
      } else {
        notify()
      }
      return
    }

    if (a === REG_MODE) {
      // Accept QuickStart then clear the latch — silicon is write-triggered.
      regs.set(REG_MODE, word & ~QUICKSTART_MODE)
      notify()
      return
    }

    if (reg.access === 'ro') return

    regs.set(a, word)
    notify()
  }

  /** Page-side measurement write — bypasses ro access. */
  const setMeasurement = (addr: number, value: number) => {
    regs.set(addr, value & 0xffff)
    notify()
  }

  const getReading = (): FuelGaugeReading => {
    const cratePctPerHour = rawToCrate(peek(REG_CRATE))
    return {
      socPct: rawToSoc(peek(REG_SOC)),
      voltageUv: rawToVoltageUv(peek(REG_VCELL)),
      cratePctPerHour,
      charging: cratePctPerHour > 0,
    }
  }

  const readBytes = (length: number): Uint8Array => {
    const out = new Uint8Array(Math.max(0, length))
    let p = pointer
    for (let i = 0; i < out.length; ) {
      const base = p & ~1
      const word = peek(base)
      if ((p & 1) === 0) {
        out[i++] = (word >> 8) & 0xff
        if (i >= out.length) {
          p = (p + 1) & 0xff
          break
        }
        out[i++] = word & 0xff
        p = (p + 2) & 0xff
      } else {
        out[i++] = word & 0xff
        p = (p + 1) & 0xff
      }
    }
    pointer = p
    return out
  }

  return {
    address,
    name,
    decl,
    registers: MAX17048_REGISTERS,
    peek,
    getPointer: () => pointer,
    poke(addr, value) {
      const a = addr & 0xff
      const reg = byAddr.get(a)
      if (!reg) return
      // Inspector may poke measurement regs even though silicon marks them ro.
      if (a === REG_VCELL || a === REG_CRATE || a === REG_SOC) {
        setMeasurement(a, value)
        pointer = a
        return
      }
      if (reg.access === 'ro') return
      writeWord(a, value)
      pointer = a
    },
    setField(addr, field, value) {
      const a = addr & 0xff
      const reg = byAddr.get(a)
      if (!reg) return
      const next = insertField(peek(a), field, value)
      if (a === REG_VCELL || a === REG_CRATE || a === REG_SOC) {
        setMeasurement(a, next)
        return
      }
      if (reg.access === 'ro') return
      writeWord(a, next)
    },
    getReg: (addr) => peek(addr),
    getReading,
    setSocPct(pct) {
      setMeasurement(REG_SOC, socToRaw(pct))
    },
    setVoltageMv(mv) {
      setMeasurement(REG_VCELL, voltageMvToRaw(mv))
    },
    setCratePctPerHour(rate) {
      setMeasurement(REG_CRATE, crateToRaw(rate))
    },
    getDetail(key) {
      const reading = getReading()
      const runtime = estimateRuntimeMins(reading)
      if (key === 'crate') {
        const sign = reading.cratePctPerHour > 0 ? '+' : ''
        return `${sign}${reading.cratePctPerHour.toFixed(1)} %/h`
      }
      if (key === 'tte') {
        return runtime.toEmpty > 0 ? `${Math.round(runtime.toEmpty)} min` : '—'
      }
      if (key === 'ttf') {
        return runtime.toFull > 0 ? `${Math.round(runtime.toFull)} min` : '—'
      }
      return ''
    },
    version: () => generation,
    write(bytes) {
      if (bytes.length === 0) return true
      pointer = bytes[0]! & 0xff
      if (bytes.length === 1) return true
      if (bytes.length >= 3) {
        const word = ((bytes[1]! & 0xff) << 8) | (bytes[2]! & 0xff)
        const a = pointer
        const reg = byAddr.get(a)
        if (reg?.access === 'ro' && a !== REG_COMMAND && a !== REG_MODE) {
          // Guest cannot overwrite measurement regs over I²C.
          return true
        }
        writeWord(a, word)
        return true
      }
      // Odd length after pointer: treat remaining as MSB-only poke of a byte.
      if (bytes.length === 2) {
        const a = pointer
        const reg = byAddr.get(a)
        if (!reg || reg.access === 'ro') return true
        const prev = peek(a)
        writeWord(a, ((bytes[1]! & 0xff) << 8) | (prev & 0xff))
      }
      return true
    },
    read(length) {
      if (length <= 0) return new Uint8Array(0)
      return readBytes(length)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** Encode helpers exported for tests. */
export const max17048Codec = {
  socToRaw,
  rawToSoc,
  voltageMvToRaw,
  rawToVoltageUv,
  crateToRaw,
  rawToCrate,
  putBe16,
  VCELL_UV_PER_LSB,
  CRATE_PCT_PER_LSB,
}
