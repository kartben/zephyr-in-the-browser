/**
 * I2C memory parts: a byte array behind a word-address pointer.
 *
 * Deliberately omitted: write-cycle NAK timing and page-boundary wrapping.
 * `persistKey` stores contents in localStorage across page reloads/MCU resets.
 */

import type { I2cChip } from '../i2c'

export interface MemoryDecl {
  name: string
  shellLabel?: string
  defaultAddress: number
  size: number
  addressWidth: 1 | 2
  /** 0xff matches blank EEPROM/flash and open-bus reads. */
  erased?: number
  pageSize?: number
}

export interface HexBacked {
  readonly memory: Uint8Array
  readonly decl: { size: number; erased?: number; pageSize?: number }
  version(): number
  pointer(): number
  poke(offset: number, value: number): void
  erase(): void
  subscribe(fn: () => void): () => void
}

export interface MemoryChip extends I2cChip, HexBacked {
  write(bytes: Uint8Array): boolean
  read(length: number): Uint8Array
  readonly decl: MemoryDecl
}

export interface MemoryChipOptions {
  address?: number
  name?: string
  size?: number
  /**
   * localStorage key for backing store. Omit for volatile parts or tests that
   * do not stub storage.
   */
  persistKey?: string
}

export function isMemoryChip(chip: I2cChip): chip is MemoryChip {
  return 'decl' in chip && 'erase' in chip && 'version' in chip && 'poke' in chip
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

/** Missing/corrupt/unavailable storage returns null; all-erased stores as absent. */
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

function savePersisted(key: string, memory: Uint8Array, erased: number): void {
  try {
    if (memory.every((b) => b === erased)) localStorage.removeItem(key)
    else localStorage.setItem(key, toHex(memory))
  } catch {
    /* quota or blocked — the part still works for this session */
  }
}

export function createMemoryChip(decl: MemoryDecl, opts: MemoryChipOptions = {}): MemoryChip {
  const address = opts.address ?? decl.defaultAddress
  const name = opts.name ?? decl.name
  const size = opts.size ?? decl.size
  const erased = decl.erased ?? 0xff
  const { addressWidth } = decl
  const persistKey = opts.persistKey

  const memory = new Uint8Array(size).fill(erased)
  if (persistKey) {
    const saved = loadPersisted(persistKey, size)
    if (saved) memory.set(saved)
  }
  let pointer = 0
  let version = 0

  const listeners = new Set<() => void>()
  // Pointer-only reads redraw the card but must not rewrite localStorage.
  const notify = (persist = true) => {
    version++
    if (persist && persistKey) savePersisted(persistKey, memory, erased)
    for (const fn of listeners) fn()
  }

  return {
    address,
    name,
    decl,
    memory,

    write(bytes) {
      // Probe/short writes ACK without moving the pointer.
      if (bytes.length < addressWidth) return true

      let addr = 0
      for (let i = 0; i < addressWidth; i++) addr = (addr << 8) | bytes[i]!
      pointer = addr % size

      const wrote = bytes.length > addressWidth
      for (let i = addressWidth; i < bytes.length; i++) {
        memory[pointer] = bytes[i]!
        pointer = (pointer + 1) % size
      }
      notify(wrote)
      return true
    },

    read(length) {
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        out[i] = memory[pointer]!
        pointer = (pointer + 1) % size
      }
      // Pointer moved; notify the card without persisting.
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
      memory[offset] = next
      notify()
    },

    erase() {
      memory.fill(erased)
      notify()
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
