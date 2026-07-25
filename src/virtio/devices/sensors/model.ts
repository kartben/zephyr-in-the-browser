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
 * registers, the channels a human drives (a slider), and the config-register
 * attributes a human toggles. {@link createSensorChip} turns the declaration
 * into an {@link I2cChip} the bus can carry unchanged, plus a small control
 * surface (`setChannel`/`setAttr`/…) the panel drives. TMP112 re-expressed this
 * way is byte-for-byte the hand-written part — which is what says the model is
 * right (see the TMP112 suite in src/virtio/i2c.test.ts).
 *
 * Scope, deliberately: this covers the point-then-read register machine most
 * simple sensors use (TMP112, LM75). Burst-read parts that auto-increment the
 * pointer across a run of registers (an accelerometer's X/Y/Z) will want an
 * increment mode added to {@link createSensorChip}; the seam is `read`.
 */

import type { I2cChip } from '../i2c'

/** Byte order of a multi-byte register on the wire. */
export type Endian = 'be' | 'le'

/** One register in the chip's address space. */
export interface RegisterDecl {
  /** Pointer value that selects this register. */
  addr: number
  /**
   * Width in bytes. 1–2 cover most parts; 3 is for left-aligned 24-bit samples
   * (e.g. LPS22HH pressure).
   */
  bytes: 1 | 2 | 3
  /**
   * `ro` registers ignore writes, the way a temperature register does — the
   * driver reads them but the part fills them in. `rw` registers store what the
   * driver writes (config, thresholds) and read it back.
   */
  access: 'rw' | 'ro'
  /** Value held at power-on / reset. */
  reset: number
  /** Byte order for a multi-byte register. Defaults to big-endian. */
  endian?: Endian
  /**
   * This 1-byte register returns the high byte of the word at `highByteOf`.
   * Used when a driver reads MSB and LSB as separate point-then-read bytes
   * (ISL29035 DATA_MSB / DATA_LSB) rather than one burst.
   */
  highByteOf?: number
}

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
  /** Always present on a built sensor (the machine provides both). */
  write(bytes: Uint8Array): boolean
  read(length: number): Uint8Array
  readonly decl: SensorDecl
  /** Drive a channel, in engineering units. Ignores non-finite input. */
  setChannel(key: string, value: number): void
  getChannel(key: string): number
  /** Set an attribute: a boolean for a `bit`, a field value for `bits`. */
  setAttr(key: string, value: boolean | number): void
  getAttr(key: string): boolean | number
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
function toWord(value: number, bytes: 1 | 2 | 3): number {
  if (bytes === 1) return value & 0xff
  if (bytes === 2) return value & 0xffff
  return value & 0xffffff
}

/** Split a register word into `bytes` bytes in the given order. */
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

/** Assemble `bytes` bytes in the given order back into a register word. */
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

  const listeners = new Set<() => void>()
  const notify = () => {
    for (const fn of listeners) fn()
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

  const chip: SensorChip = {
    address,
    name,
    decl,

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
      channelValues.set(key, value)
      notify()
    },
    getChannel: (key) => channelValues.get(key) ?? 0,

    setAttr(key, value) {
      const attr = decl.attributes?.find((a) => a.key === key)
      if (!attr) return
      const current = regs.get(attr.reg) ?? 0
      let next = current
      if (attr.bit !== undefined) {
        next = value ? current | (1 << attr.bit) : current & ~(1 << attr.bit)
      } else if (attr.bits) {
        const mask = ((1 << attr.bits.width) - 1) << attr.bits.shift
        next = (current & ~mask) | ((Number(value) << attr.bits.shift) & mask)
      }
      if (next !== current) {
        regs.set(attr.reg, next & 0xffff)
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

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }

  return chip
}
