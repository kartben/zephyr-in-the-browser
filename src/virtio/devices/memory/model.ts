/**
 * A declarative model for I2C memory parts — EEPROMs, FRAMs, anything whose
 * whole behaviour is "a byte array behind a word-address pointer".
 *
 * The sibling of src/virtio/devices/sensors/model.ts, and for the same reason:
 * once there is more than one such chip, everything but the geometry is the
 * same plumbing. A write carries a word address and then data; a read streams
 * from an internal pointer that auto-increments and wraps. Only the size, the
 * address width and the erased value differ.
 *
 * A part is a {@link MemoryDecl}; {@link createMemoryChip} turns it into an
 * {@link I2cChip} the bus carries unchanged, plus the surface its card needs —
 * the backing store to render, a version counter to coalesce repaints against,
 * the pointer to show where the guest is reading, poke/erase, and session
 * {@link MemoryStats} (reads / writes / occupancy / per-page write wear) so
 * the card stays a pure consumer. An optional `persistKey` keeps the backing
 * store in localStorage across page reloads — the board AT24 uses it so the
 * stock EEPROM boot-counter sample survives an "MCU reset".
 *
 * Deliberately not modelled: write cycle time. A real AT24 NAKs for a few
 * milliseconds after a write while the page programs, and drivers poll for
 * that; here the write lands immediately. When {@link MemoryDecl.pageSize} is
 * set, data writes wrap within the page (real AT24 behaviour); otherwise the
 * pointer wraps at the end of the device.
 */

import type { I2cChip } from '../i2c'

export interface MemoryDecl {
  /** Shown in the bus roster, the transaction log and the card header. */
  name: string
  /**
   * Zephyr device name for the EEPROM shell (e.g. `EEPROM_0`), used to build
   * the card's command hint. Omit for a part with no EEPROM-API driver.
   */
  shellLabel?: string
  /** Address the part ships at; the roster seeds its picker from this. */
  defaultAddress: number
  /** Capacity in bytes. */
  size: number
  /**
   * Width of the word address a write carries before its data. One byte covers
   * parts up to 256 bytes (the AT24C02); larger ones need two.
   */
  addressWidth: 1 | 2
  /**
   * What an unwritten cell reads as. 0xff for EEPROM and flash — and for an
   * open bus, which means a driver that finds 0xff everywhere cannot tell a
   * blank part from a missing one. That is true of the real chip too.
   */
  erased?: number
  /**
   * Programming page size. When set, a write that runs off a page wraps
   * within that page (AT24-style), and the card's wear map is keyed per page.
   */
  pageSize?: number
  /**
   * Rated write cycles per page (datasheet endurance). Scales the page wear
   * map when set; omit for a relative (max-in-session) scale.
   */
  enduranceCycles?: number
}

/** Session bus activity + occupancy for the EEPROM card. */
export interface MemoryStats {
  readOps: number
  readBytes: number
  writeOps: number
  writeBytes: number
  /** Non-erased byte count. */
  usedBytes: number
  /** Pages with at least one non-erased byte (0 when pageSize is unset). */
  dirtyPages: number
  pageCount: number
  /** Per-page write counts (one bump per write() that touches the page). */
  pageWriteCounts: Uint32Array
  /** Non-erased bytes per page. */
  pageUsedBytes: Uint32Array
  maxPageWrites: number
}

/** A byte array the hex dump / preview can render and poke. */
export interface HexBacked {
  readonly memory: Uint8Array
  readonly decl: { size: number; erased?: number; pageSize?: number }
  version(): number
  pointer(): number
  poke(offset: number, value: number): void
  erase(): void
  subscribe(fn: () => void): () => void
}

/** A memory part on the bus, plus the handle its card drives. */
export interface MemoryChip extends I2cChip, HexBacked {
  /** Always present on a built memory part (the machine provides both). */
  write(bytes: Uint8Array): boolean
  read(length: number): Uint8Array
  readonly decl: MemoryDecl
  stats(): MemoryStats
  /** Clear session counters and page wear; does not touch the image. */
  resetStats(): void
}

export interface MemoryChipOptions {
  /** Override the declared address (a second part on a spare strap). */
  address?: number
  /** Override the displayed name. */
  name?: string
  /** Override the capacity (an AT24 variant on the same declaration). */
  size?: number
  /**
   * localStorage key for the backing store. When set, contents survive page
   * reloads — which is what makes an EEPROM an EEPROM across a "MCU reset"
   * (`location.reload` in this app). Omit for a volatile part, or in tests
   * that do not stub storage.
   */
  persistKey?: string
}

/**
 * Whether a chip on the bus is a declared memory part (and so has a card).
 * Sensors also expose `poke` (register-map edits) and the SSD1306 exposes
 * GDDRAM as `memory`, so the discriminant is the EEPROM-specific surface:
 * `erase` + `version` + `stats`.
 */
export function isMemoryChip(chip: I2cChip): chip is MemoryChip {
  return (
    'decl' in chip &&
    'erase' in chip &&
    'version' in chip &&
    'poke' in chip &&
    typeof (chip as MemoryChip).stats === 'function'
  )
}

/** Hex-encode a byte array for localStorage (512 chars for a 256-byte AT24). */
function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

/**
 * Restore a previously saved image, or null when missing/corrupt/unavailable.
 * A blank (all-erased) part is stored as an absent key, so a fresh create and
 * a post-erase create look the same.
 */
function loadPersisted(key: string, size: number): Uint8Array | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw || raw.length !== size * 2 || !/^[0-9a-fA-F]+$/.test(raw)) return null
    const out = new Uint8Array(size)
    for (let i = 0; i < size; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16)
    return out
  } catch {
    return null // private mode, SSR, or blocked storage
  }
}

/** Persist, or drop the key when every cell is erased (storage hygiene). */
function savePersisted(key: string, memory: Uint8Array, erased: number): void {
  try {
    if (memory.every((b) => b === erased)) localStorage.removeItem(key)
    else localStorage.setItem(key, toHex(memory))
  } catch {
    /* quota or blocked — the part still works for this session */
  }
}

function countUsed(memory: Uint8Array, base: number, len: number, erased: number): number {
  let n = 0
  for (let i = 0; i < len; i++) if (memory[base + i] !== erased) n++
  return n
}

export function memoryUsedFraction(stats: MemoryStats, size: number): number {
  if (size <= 0) return 0
  return Math.min(1, Math.max(0, stats.usedBytes / size))
}

/** Build a live {@link MemoryChip} from a declaration. */
export function createMemoryChip(decl: MemoryDecl, opts: MemoryChipOptions = {}): MemoryChip {
  const address = opts.address ?? decl.defaultAddress
  const name = opts.name ?? decl.name
  const size = opts.size ?? decl.size
  const erased = decl.erased ?? 0xff
  const { addressWidth } = decl
  const pageSize = decl.pageSize && decl.pageSize > 0 ? decl.pageSize : undefined
  const persistKey = opts.persistKey

  const memory = new Uint8Array(size).fill(erased)
  if (persistKey) {
    const saved = loadPersisted(persistKey, size)
    if (saved) memory.set(saved)
  }

  const pageCount = pageSize ? Math.ceil(size / pageSize) : 0
  const pageUsedBytes = new Uint32Array(pageCount)
  const pageWriteCounts = new Uint32Array(pageCount)
  let usedBytes = 0
  if (pageSize) {
    for (let pi = 0; pi < pageCount; pi++) {
      const base = pi * pageSize
      const len = Math.min(pageSize, size - base)
      const n = countUsed(memory, base, len, erased)
      pageUsedBytes[pi] = n
      usedBytes += n
    }
  } else {
    usedBytes = countUsed(memory, 0, size, erased)
  }

  let readOps = 0
  let readBytes = 0
  let writeOps = 0
  let writeBytes = 0
  let maxPageWrites = 0
  let pointer = 0
  let version = 0

  const listeners = new Set<() => void>()
  // `persist` is for content changes only — a read moves the pointer (the card
  // redraws it) but must not rewrite localStorage on every guest poll.
  const notify = (persist = true) => {
    version++
    if (persist && persistKey) savePersisted(persistKey, memory, erased)
    for (const fn of listeners) fn()
  }

  const noteCellWrite = (addr: number, next: number) => {
    const prev = memory[addr]!
    memory[addr] = next
    if (prev === next) return
    if (pageSize) {
      const pi = Math.floor(addr / pageSize)
      if (prev === erased && next !== erased) {
        pageUsedBytes[pi]!++
        usedBytes++
      } else if (prev !== erased && next === erased) {
        pageUsedBytes[pi]!--
        usedBytes--
      }
    } else if (prev === erased && next !== erased) {
      usedBytes++
    } else if (prev !== erased && next === erased) {
      usedBytes--
    }
  }

  const advanceWritePointer = () => {
    if (!pageSize) {
      pointer = (pointer + 1) % size
      return
    }
    const pageBase = pointer - (pointer % pageSize)
    const pageEnd = Math.min(pageBase + pageSize, size)
    const next = pointer + 1
    pointer = next >= pageEnd ? pageBase : next
  }

  const dirtyPages = () => {
    let n = 0
    for (let i = 0; i < pageCount; i++) if (pageUsedBytes[i]! > 0) n++
    return n
  }

  return {
    address,
    name,
    decl,
    memory,

    write(bytes) {
      // A zero-length write is how some drivers probe for the chip, and a write
      // too short to carry a whole word address cannot address anything — both
      // are acknowledged without moving the pointer.
      if (bytes.length < addressWidth) return true

      let addr = 0
      for (let i = 0; i < addressWidth; i++) addr = (addr << 8) | bytes[i]!
      pointer = addr % size

      // Anything after the address is data — page wrap when pageSize is set,
      // otherwise wrap at the end of the device.
      const wrote = bytes.length > addressWidth
      if (wrote) {
        writeOps++
        const touched = pageSize ? new Set<number>() : null
        for (let i = addressWidth; i < bytes.length; i++) {
          if (touched) touched.add(Math.floor(pointer / pageSize!))
          noteCellWrite(pointer, bytes[i]!)
          writeBytes++
          advanceWritePointer()
        }
        if (touched) {
          for (const pi of touched) {
            const next = (pageWriteCounts[pi]! + 1) >>> 0
            pageWriteCounts[pi] = next
            if (next > maxPageWrites) maxPageWrites = next
          }
        }
      }
      notify(wrote)
      return true
    },

    read(length) {
      const out = new Uint8Array(length)
      if (length > 0) {
        readOps++
        for (let i = 0; i < length; i++) {
          out[i] = memory[pointer]!
          pointer = (pointer + 1) % size
          readBytes++
        }
      }
      // The pointer moved, and the card draws it — so a read is a change too.
      notify(false)
      return out
    },

    version: () => version,
    pointer: () => pointer,

    poke(offset, value) {
      if (!Number.isInteger(offset) || offset < 0 || offset >= size) return
      if (!Number.isInteger(value)) return
      const next = value & 0xff
      if (memory[offset] === next) return
      noteCellWrite(offset, next)
      notify()
    },

    erase() {
      memory.fill(erased)
      usedBytes = 0
      pageUsedBytes.fill(0)
      notify()
    },

    stats(): MemoryStats {
      return {
        readOps,
        readBytes,
        writeOps,
        writeBytes,
        usedBytes,
        dirtyPages: dirtyPages(),
        pageCount,
        pageWriteCounts,
        pageUsedBytes,
        maxPageWrites,
      }
    },

    resetStats() {
      readOps = 0
      readBytes = 0
      writeOps = 0
      writeBytes = 0
      pageWriteCounts.fill(0)
      maxPageWrites = 0
      notify(false)
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
