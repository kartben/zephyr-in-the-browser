/**
 * Shared SVD-inspired register-map types for any I²C (or similar) part that
 * has a named register file — sensors, RTCs, and future chips. Not a full
 * CMSIS-SVD: just addr / width / access / reset / bitfields, plus the live
 * peek/poke surface the inspector UI needs.
 *
 * Channel codecs, RTC timekeeping, and OLED command streams stay in their
 * own frameworks; this module is only the map schema and the common handle.
 */

/** Byte order of a multi-byte register on the wire. */
export type Endian = 'be' | 'le'

/**
 * One named bitfield inside a register.
 *
 * Inclusive `[lsb, msb]` matches CMSIS-SVD's `bitRange`. Enumerated `values`
 * are optional display/edit metadata for the register-map UI.
 */
export interface FieldDecl {
  /** Short datasheet name (e.g. `ODR_XL`, `STOP`, `AF`). */
  name: string
  /** Least-significant bit, inclusive. */
  lsb: number
  /** Most-significant bit, inclusive. */
  msb: number
  description?: string
  /** Optional enumerated encodings for this field. */
  values?: Array<{ name: string; value: number; description?: string }>
}

/** One register in the chip's address space. */
export interface RegisterDecl {
  /** Pointer value that selects this register. */
  addr: number
  /**
   * Width in bytes. 1–2 cover most parts; 3 is for left-aligned 24-bit samples
   * (e.g. LPS22HH pressure); 4 is for SPI register words (TMC50xx).
   */
  bytes: 1 | 2 | 3 | 4
  /**
   * `ro` registers ignore writes. `rw` registers store what the driver (or the
   * register-map editor) writes and read it back.
   */
  access: 'rw' | 'ro'
  /** Value held at power-on / reset. */
  reset: number
  /** Byte order for a multi-byte register. Defaults to big-endian. */
  endian?: Endian
  /**
   * This 1-byte register returns the high byte of the word at `highByteOf`.
   * Used when a driver reads MSB and LSB as separate point-then-read bytes.
   */
  highByteOf?: number
  /** Datasheet / SVD-style register name (e.g. `Control_1`, `CTRL1_XL`). */
  name?: string
  description?: string
  /** Named bitfields within this register, for the register-map UI. */
  fields?: FieldDecl[]
}

/**
 * Live register file the {@link RegisterMapButton} dialog drives. Sensors,
 * RTCs, and any future register-based part implement this — the UI does not
 * care which framework built the chip.
 */
export interface RegisterMapSource {
  name: string
  address: number
  registers: readonly RegisterDecl[]
  /** Live register word as a guest read would see it right now. */
  peek(addr: number): number
  /** Current pointer register (last pointed-at address). */
  getPointer(): number
  /** Overwrite an entire `rw` register word. No-op for ro/unknown. */
  poke(addr: number, value: number): void
  /** Read-modify-write a bitfield on an `rw` register. */
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  subscribe(fn: () => void): () => void
}

/** Whether a chip exposes a non-empty register map for the inspector. */
export function hasRegisterMap(
  chip: Partial<RegisterMapSource> | null | undefined,
): chip is RegisterMapSource {
  return (
    !!chip &&
    typeof chip.peek === 'function' &&
    typeof chip.getPointer === 'function' &&
    typeof chip.poke === 'function' &&
    typeof chip.setField === 'function' &&
    typeof chip.subscribe === 'function' &&
    Array.isArray(chip.registers) &&
    chip.registers.length > 0 &&
    typeof chip.name === 'string' &&
    typeof chip.address === 'number'
  )
}
