/**
 * A declarative model for simple register-file I2C sensors, in the page.
 *
 * The point of the browser's I2C chips is the driver on the other side: a real
 * Zephyr sensor driver binds to a page-side model over a real bus (see
 * src/virtio/devices/chips/tmp112.ts for the first one, written by hand). Once
 * there is a second and a third such sensor, almost all of that hand-written
 * chip is the same plumbing: a register pointer, a map of registers, and a
 * "temperature register that is really a slider" whose bytes are computed at
 * read time. Only the register layout and the encoding differ.
 *
 * This module is that plumbing, once. A sensor is a {@link SensorDecl}: its
 * registers (optionally named, with SVD-inspired bitfields — see
 * {@link ./registerMap.ts} and `maps/*.json`), the channels a human drives (a
 * slider), and the config-register attributes a human toggles.
 * {@link createSensorChip} turns the declaration into an {@link I2cChip} the
 * bus can carry unchanged, plus a small control surface
 * (`setChannel`/`setAttr`/`peek`/…) the panel drives. TMP112 re-expressed this
 * way is byte-for-byte the hand-written part — which is what says the model is
 * right (see the TMP112 suite in src/virtio/i2c.test.ts).
 *
 * Scope, deliberately: this covers the point-then-read register machine most
 * simple sensors use (TMP112, LM75). Burst-read parts that auto-increment the
 * pointer across a run of registers (an accelerometer's X/Y/Z) will want an
 * increment mode added to {@link createSensorChip}; the seam is `read`.
 */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import type { Endian, FieldDecl, RegisterDecl } from '../registers/types'

export type { Endian, FieldDecl, RegisterDecl } from '../registers/types'

/**
 * What an encoder is allowed to see: the chip's current register values, so a
 * mode bit in the config register can change how a channel encodes (TMP112's
 * extended mode is exactly this). Reading the register the channel itself lives
 * in is fine but pointless — its value is what we are computing.
 */
export interface CodecCtx {
  /** Current value of a register, by address. Absent registers read as 0. */
  reg(addr: number): number
}

/**
 * A physical quantity a human drives — one slider in the panel. Its value is
 * kept in engineering units (°C, m/s²) and encoded into `reg` at read time, so
 * a mode change is reflected without the driver having to write anything.
 */
export interface ChannelDecl {
  /** Stable key used by setChannel/getChannel and as a React key. */
  key: string
  /** Slider label. */
  label: string
  /** Zephyr sensor channel, for the `sensor get` hint and docs. */
  zephyr: string
  /** Engineering unit, shown next to the value. */
  unit: string
  /** Slider bounds, in engineering units. */
  min: number
  max: number
  /** Slider granularity; defaults to (max-min)/200 like the existing panels. */
  step?: number
  /** Initial value before anything sets one; defaults to `min`. */
  initial?: number
  /** Register this channel is read out of. */
  reg: number
  /** Engineering value -> the raw register word the driver will decode. */
  encode(value: number, ctx: CodecCtx): number
  /** Optional live browser source that can drive this channel (see SensorCard). */
  source?: LiveSourceKind
}

/** Browser sensors a channel can follow instead of its slider. */
export type LiveSourceKind = 'orientation-x' | 'orientation-y' | 'orientation-z' | 'battery'

/**
 * A field of a config register a human toggles. `bit` is a single on/off flag;
 * `bits` is a multi-value field rendered as a select. Writing an attribute is a
 * read-modify-write of the underlying `rw` register, so the driver reads back
 * exactly what the panel set and vice versa.
 */
export interface AttrDecl {
  key: string
  label: string
  /** The `rw` register this field lives in. */
  reg: number
  /** A single-bit flag at this position. Mutually exclusive with `bits`. */
  bit?: number
  /** A multi-bit field. Mutually exclusive with `bit`. */
  bits?: {
    /** Least-significant bit position of the field. */
    shift: number
    /** Field width in bits. */
    width: number
    /** Selectable values, in field units (pre-shift). */
    options: Array<{ label: string; value: number }>
  }
}

/** The full description of a simple sensor. */
export interface SensorDecl {
  /** Shown in the bus roster and the transaction log. */
  name: string
  /**
   * Devicetree node label, for the `sensor get <label>@<addr>` hint in the
   * card. Omit when the part has no stock Zephyr sensor binding.
   */
  shellLabel?: string
  /** Address the part ships at; the roster seeds the picker from this. */
  defaultAddress: number
  /** Mask applied to the pointer byte (TMP112 keeps only the low two bits). */
  pointerMask?: number
  /**
   * Whether a read walks forward through the register file. Off (default): a
   * read repeats the pointed register, which is how a point-then-read part like
   * TMP112 behaves. On: a read that outruns the pointed register continues into
   * the next one by address, the way a burst-read part (an accelerometer's
   * X/Y/Z at consecutive registers) streams. The register addresses must be
   * laid out contiguously in byte space for this to line up. The pointer itself
   * is not advanced — a burst re-points first, as `i2c_burst_read` does.
   */
  autoIncrement?: boolean
  registers: RegisterDecl[]
  channels: ChannelDecl[]
  attributes?: AttrDecl[]
}

/**
 * A sensor on the bus, plus the handle the panel drives. It *is* an I2cChip, so
 * `i2cModel.attachChip(chip)` takes it directly.
 */
export interface SensorChip extends I2cChip {
  /** Always present on a built sensor (the machine provides all three). */
  write(bytes: Uint8Array): boolean
  read(length: number): Uint8Array
  startRead(): void
  readonly decl: SensorDecl
  /** Same list as `decl.registers` — {@link RegisterMapSource} surface. */
  readonly registers: readonly RegisterDecl[]
  /** Drive a channel, in engineering units. Ignores non-finite input. */
  setChannel(key: string, value: number): void
  getChannel(key: string): number
  /** Set an attribute: a boolean for a `bit`, a field value for `bits`. */
  setAttr(key: string, value: boolean | number): void
  getAttr(key: string): boolean | number
  /**
   * Live register word as a guest read would see it right now — channel
   * encoding included. The register-map UI peeks this rather than re-issuing
   * an I²C transaction.
   */
  peek(addr: number): number
  /** Current pointer register (last pointed-at address). */
  getPointer(): number
  /**
   * Overwrite an entire `rw` register word. Read-only / unknown addresses are
   * ignored, matching a real part. Used by the register-map editor.
   */
  poke(addr: number, value: number): void
  /**
   * Read-modify-write a bitfield on an `rw` register. No-op when the address
   * is missing or read-only.
   */
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  /** Notified whenever a channel or attribute changes. */
  subscribe(fn: () => void): () => void
}

export interface SensorChipOptions {
  /** Override the declared address (a second instance on a spare slot). */
  address?: number
  /** Override the displayed name. */
  name?: string
}

/** Whether a chip on the bus is a declared sensor (and so has a SensorCard). */
export function isSensorChip(chip: I2cChip): chip is SensorChip {
  return 'decl' in chip && 'setChannel' in chip
}

/** Mask a value into a `bytes`-wide word. */
function toWord(value: number, bytes: 1 | 2 | 3 | 4): number {
  if (bytes === 1) return value & 0xff
  if (bytes === 2) return value & 0xffff
  if (bytes === 3) return value & 0xffffff
  return value >>> 0
}

/** Split a register word into `bytes` bytes in the given order. */
function wordToBytes(value: number, bytes: 1 | 2 | 3 | 4, endian: Endian): number[] {
  if (bytes === 1) return [value & 0xff]
  if (bytes === 2) {
    const hi = (value >> 8) & 0xff
    const lo = value & 0xff
    return endian === 'le' ? [lo, hi] : [hi, lo]
  }
  if (bytes === 3) {
    const b0 = value & 0xff
    const b1 = (value >> 8) & 0xff
    const b2 = (value >> 16) & 0xff
    return endian === 'le' ? [b0, b1, b2] : [b2, b1, b0]
  }
  const b0 = value & 0xff
  const b1 = (value >> 8) & 0xff
  const b2 = (value >> 16) & 0xff
  const b3 = (value >>> 24) & 0xff
  return endian === 'le' ? [b0, b1, b2, b3] : [b3, b2, b1, b0]
}

/** Assemble `bytes` bytes in the given order back into a register word. */
function bytesToWord(src: Uint8Array, bytes: 1 | 2 | 3 | 4, endian: Endian): number {
  if (bytes === 1) return src[0] ?? 0
  if (bytes === 2) {
    const first = src[0] ?? 0
    const second = src[1] ?? 0
    return endian === 'le' ? ((second << 8) | first) & 0xffff : ((first << 8) | second) & 0xffff
  }
  if (bytes === 3) {
    const a = src[0] ?? 0
    const b = src[1] ?? 0
    const c = src[2] ?? 0
    return endian === 'le'
      ? ((c << 16) | (b << 8) | a) & 0xffffff
      : ((a << 16) | (b << 8) | c) & 0xffffff
  }
  const a = src[0] ?? 0
  const b = src[1] ?? 0
  const c = src[2] ?? 0
  const d = src[3] ?? 0
  return endian === 'le'
    ? ((d << 24) | (c << 16) | (b << 8) | a) >>> 0
    : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

/**
 * Build a live {@link SensorChip} from a declaration. The returned object is an
 * I2cChip; the extra methods are the panel's control surface.
 */
export function createSensorChip(decl: SensorDecl, opts: SensorChipOptions = {}): SensorChip {
  const address = opts.address ?? decl.defaultAddress
  const name = opts.name ?? decl.name
  const pointerMask = decl.pointerMask ?? 0xff

  const regByAddr = new Map(decl.registers.map((r) => [r.addr, r]))
  const chanByReg = new Map(decl.channels.map((c) => [c.reg, c]))

  /** Stored register words (rw registers, and the reset value of ro ones). */
  const regs = new Map<number, number>(decl.registers.map((r) => [r.addr, r.reset]))
  /** Channel values, in engineering units — the source of truth for ro channel regs. */
  const channelValues = new Map<string, number>(
    decl.channels.map((c) => [c.key, c.initial ?? c.min]),
  )

  let pointer = decl.registers[0]?.addr ?? 0
  /**
   * How far into the current read message the next byte comes from. A part
   * like this restarts at the pointed register on every read message, so a
   * fresh address phase rewinds it (see I2cChip.startRead); within one message
   * it carries on, which is what a bus that hands a read over in pieces needs.
   */
  let readOffset = 0

  const listeners = new Set<() => void>()
  // Coalesce notifies that land in the same turn (e.g. three orientation axes
  // from one DeviceOrientationEvent) so React pays for one render, not N.
  // queueMicrotask keeps the model testable without fake timers; the guest
  // never waits on these listeners — it reads registers on demand.
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

  /** The word a read at `pointer` should return right now. */
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

  /** The first `count` bytes a read message would produce from `pointer`. */
  function messageBytes(count: number): Uint8Array {
    const out = new Uint8Array(count)

    if (decl.autoIncrement) {
      // Stream forward across the register file: emit the pointed register,
      // then the next by address, and so on. A gap between declared registers
      // reads as open bus (0xff), like the real part.
      let addr = pointer
      let i = 0
      while (i < count) {
        const reg = regByAddr.get(addr)
        if (!reg) {
          out[i++] = 0xff
          addr += 1
          continue
        }
        const pattern = wordToBytes(currentWord(addr), reg.bytes, reg.endian ?? 'be')
        for (const b of pattern) if (i < count) out[i++] = b
        addr += reg.bytes
      }
      return out
    }

    const reg = regByAddr.get(pointer)
    const pattern = wordToBytes(currentWord(pointer), reg?.bytes ?? 2, reg?.endian ?? 'be')
    // A read longer than the register repeats it, the way a point-then-read
    // part does rather than running off into whatever follows.
    for (let i = 0; i < count; i++) out[i] = pattern[i % pattern.length]
    return out
  }

  const chip: SensorChip = {
    address,
    name,
    decl,
    registers: decl.registers,

    write(bytes) {
      if (bytes.length === 0) return true
      pointer = bytes[0] & pointerMask
      // Pointing at a register is the other thing that decides where a read
      // starts, so it rewinds too — a driver does [write pointer][restart]
      // [read], and a caller holding the chip directly does the same in two
      // calls with no bus in between.
      readOffset = 0
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

    startRead() {
      readOffset = 0
    },

    read(length) {
      // Generate the message from its start and hand back the slice this read
      // asks for. Recomputing the prefix is what makes a split read safe: the
      // bytes are pure functions of the registers, so nothing is consumed
      // twice and a chunked read comes out the same as a whole one.
      const from = readOffset
      readOffset += length
      return messageBytes(from + length).subarray(from)
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

/** Re-export field helpers so callers can peek/decode without a second import. */
export {
  extractField,
  formatBitRange,
  formatRegHex,
  decodeFieldLabel,
} from '../registers/fields'
