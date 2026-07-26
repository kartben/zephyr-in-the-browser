/** Declarative register-file model for page-side I²C sensors. */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import type { Endian, FieldDecl, RegisterDecl } from '../registers/types'

export type { Endian, FieldDecl, RegisterDecl } from '../registers/types'

export interface CodecCtx {
  reg(addr: number): number
}

export interface ChannelDecl {
  key: string
  label: string
  zephyr: string
  unit: string
  min: number
  max: number
  step?: number
  initial?: number
  reg: number
  /** Engineering value -> live raw register word; ctx exposes config/mode bits. */
  encode(value: number, ctx: CodecCtx): number
  source?: LiveSourceKind
}

export type LiveSourceKind = 'orientation-x' | 'orientation-y' | 'orientation-z' | 'battery'

export interface AttrDecl {
  key: string
  label: string
  reg: number
  bit?: number
  bits?: {
    shift: number
    width: number
    options: Array<{ label: string; value: number }>
  }
}

export interface SensorDecl {
  name: string
  shellLabel?: string
  defaultAddress: number
  pointerMask?: number
  /**
   * On: reads stream across contiguous register addresses; off: repeats the
   * pointed register. The pointer itself is not advanced.
   */
  autoIncrement?: boolean
  registers: RegisterDecl[]
  channels: ChannelDecl[]
  attributes?: AttrDecl[]
}

export interface SensorChip extends I2cChip {
  write(bytes: Uint8Array): boolean
  read(length: number): Uint8Array
  readonly decl: SensorDecl
  readonly registers: readonly RegisterDecl[]
  setChannel(key: string, value: number): void
  getChannel(key: string): number
  setAttr(key: string, value: boolean | number): void
  getAttr(key: string): boolean | number
  /** Live register word as a guest read would see it, channel encoding included. */
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  subscribe(fn: () => void): () => void
}

export interface SensorChipOptions {
  address?: number
  name?: string
}

export function isSensorChip(chip: I2cChip): chip is SensorChip {
  return 'decl' in chip && 'setChannel' in chip
}

function toWord(value: number, bytes: 1 | 2 | 3): number {
  if (bytes === 1) return value & 0xff
  if (bytes === 2) return value & 0xffff
  return value & 0xffffff
}

/** Split a register word into bytes in the declared endian order. */
function wordToBytes(value: number, bytes: 1 | 2 | 3, endian: Endian): number[] {
  if (bytes === 1) return [value & 0xff]
  if (bytes === 2) {
    const hi = (value >> 8) & 0xff
    const lo = value & 0xff
    return endian === 'le' ? [lo, hi] : [hi, lo]
  }
  const b0 = value & 0xff
  const b1 = (value >> 8) & 0xff
  const b2 = (value >> 16) & 0xff
  return endian === 'le' ? [b0, b1, b2] : [b2, b1, b0]
}

/** Assemble bytes back into a register word in the declared endian order. */
function bytesToWord(src: Uint8Array, bytes: 1 | 2 | 3, endian: Endian): number {
  if (bytes === 1) return src[0] ?? 0
  if (bytes === 2) {
    const first = src[0] ?? 0
    const second = src[1] ?? 0
    return endian === 'le' ? ((second << 8) | first) & 0xffff : ((first << 8) | second) & 0xffff
  }
  const a = src[0] ?? 0
  const b = src[1] ?? 0
  const c = src[2] ?? 0
  return endian === 'le'
    ? ((c << 16) | (b << 8) | a) & 0xffffff
    : ((a << 16) | (b << 8) | c) & 0xffffff
}

export function createSensorChip(decl: SensorDecl, opts: SensorChipOptions = {}): SensorChip {
  const address = opts.address ?? decl.defaultAddress
  const name = opts.name ?? decl.name
  const pointerMask = decl.pointerMask ?? 0xff

  const regByAddr = new Map(decl.registers.map((r) => [r.addr, r]))
  const chanByReg = new Map(decl.channels.map((c) => [c.reg, c]))

  const regs = new Map<number, number>(decl.registers.map((r) => [r.addr, r.reset]))
  const channelValues = new Map<string, number>(
    decl.channels.map((c) => [c.key, c.initial ?? c.min]),
  )

  let pointer = decl.registers[0]?.addr ?? 0

  const listeners = new Set<() => void>()
  // Coalesce same-turn notifies; the guest reads registers on demand.
  let notifyScheduled = false
  const notify = () => {
    if (notifyScheduled) return
    notifyScheduled = true
    queueMicrotask(() => {
      notifyScheduled = false
      for (const fn of listeners) fn()
    })
  }

  const ctx: CodecCtx = { reg: (addr) => regs.get(addr) ?? 0 }

  function currentWord(addr: number): number {
    const reg = regByAddr.get(addr)
    if (reg?.highByteOf !== undefined) {
      return (currentWord(reg.highByteOf) >> 8) & 0xff
    }
    const channel = chanByReg.get(addr)
    if (channel) {
      const value = channelValues.get(channel.key) ?? channel.min
      return toWord(channel.encode(value, ctx), reg?.bytes ?? 2)
    }
    return regs.get(addr) ?? 0
  }

  const chip: SensorChip = {
    address,
    name,
    decl,
    registers: decl.registers,

    write(bytes) {
      if (bytes.length === 0) return true
      pointer = bytes[0] & pointerMask
      // A pointer-only write is the first half of a register read.
      if (bytes.length < 2) return true

      const reg = regByAddr.get(pointer)
      if (reg && reg.access === 'rw') {
        regs.set(pointer, bytesToWord(bytes.subarray(1), reg.bytes, reg.endian ?? 'be'))
        notify()
      }
      // ro registers (and unknown pointers) swallow the write, as the parts do.
      return true
    },

    read(length) {
      const out = new Uint8Array(length)

      if (decl.autoIncrement) {
        // Stream forward across the register file: emit the pointed register,
        // then the next by address, and so on. A gap between declared registers
        // reads as open bus (0xff), like the real part.
        let addr = pointer
        let i = 0
        while (i < length) {
          const reg = regByAddr.get(addr)
          if (!reg) {
            out[i++] = 0xff
            addr += 1
            continue
          }
          const pattern = wordToBytes(currentWord(addr), reg.bytes, reg.endian ?? 'be')
          for (const b of pattern) if (i < length) out[i++] = b
          addr += reg.bytes
        }
        return out
      }

      const reg = regByAddr.get(pointer)
      const pattern = wordToBytes(currentWord(pointer), reg?.bytes ?? 2, reg?.endian ?? 'be')
      // A read longer than the register repeats it, the way a point-then-read
      // part does rather than running off into whatever follows.
      for (let i = 0; i < length; i++) out[i] = pattern[i % pattern.length]
      return out
    },

    setChannel(key, value) {
      if (!channelValues.has(key) || !Number.isFinite(value)) return
      const previous = channelValues.get(key)!
      if (previous === value) return
      channelValues.set(key, value)
      // Orientation noise often moves the engineering value without changing
      // the on-wire register word. Skip the UI notify in that case — the next
      // guest read already sees the stored value via currentWord().
      const channel = decl.channels.find((c) => c.key === key)
      const reg = channel ? regByAddr.get(channel.reg) : undefined
      if (channel && reg) {
        const before = toWord(channel.encode(previous, ctx), reg.bytes)
        const after = toWord(channel.encode(value, ctx), reg.bytes)
        if (before === after) return
      }
      notify()
    },
    getChannel: (key) => channelValues.get(key) ?? 0,

    setAttr(key, value) {
      const attr = decl.attributes?.find((a) => a.key === key)
      if (!attr) return
      const reg = regByAddr.get(attr.reg)
      const current = regs.get(attr.reg) ?? 0
      let next = current
      if (attr.bit !== undefined) {
        next = value ? current | (1 << attr.bit) : current & ~(1 << attr.bit)
      } else if (attr.bits) {
        const mask = ((1 << attr.bits.width) - 1) << attr.bits.shift
        next = (current & ~mask) | ((Number(value) << attr.bits.shift) & mask)
      }
      if (next !== current) {
        regs.set(attr.reg, toWord(next, reg?.bytes ?? 2))
        notify()
      }
    },
    getAttr(key) {
      const attr = decl.attributes?.find((a) => a.key === key)
      if (!attr) return 0
      const current = regs.get(attr.reg) ?? 0
      if (attr.bit !== undefined) return (current & (1 << attr.bit)) !== 0
      if (attr.bits) return (current >> attr.bits.shift) & ((1 << attr.bits.width) - 1)
      return 0
    },

    peek: (addr) => currentWord(addr),
    getPointer: () => pointer,

    poke(addr, value) {
      const reg = regByAddr.get(addr)
      if (!reg || reg.access !== 'rw') return
      const next = toWord(value, reg.bytes)
      if (regs.get(addr) === next) return
      regs.set(addr, next)
      notify()
    },

    setField(addr, field, value) {
      const reg = regByAddr.get(addr)
      if (!reg || reg.access !== 'rw') return
      if (field.msb < field.lsb) return
      const current = regs.get(addr) ?? 0
      const next = toWord(insertField(current, field, value), reg.bytes)
      if (next === current) return
      regs.set(addr, next)
      notify()
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }

  return chip
}

export {
  extractField,
  formatBitRange,
  formatRegHex,
  decodeFieldLabel,
} from '../registers/fields'
