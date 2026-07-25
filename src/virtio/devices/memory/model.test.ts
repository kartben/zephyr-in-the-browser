import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryChip, isMemoryChip, type MemoryDecl } from './model'
import { createAt24 } from './at24'
import { createSsd1306 } from '../chips/ssd1306'
import { createTmp112 } from '../sensors/tmp112'

/** A two-byte-addressed part, which no chip on the bus exercises today. */
const wideDecl: MemoryDecl = {
  name: 'Wide EEPROM',
  defaultAddress: 0x54,
  size: 1024,
  addressWidth: 2,
  pageSize: 32,
}

describe('createMemoryChip', () => {
  it('addresses with a two-byte word address', () => {
    const chip = createMemoryChip(wideDecl)
    // Word address 0x0102, then two data bytes.
    chip.write(Uint8Array.of(0x01, 0x02, 0xde, 0xad))
    expect(chip.memory[0x102]).toBe(0xde)
    expect(chip.memory[0x103]).toBe(0xad)

    chip.write(Uint8Array.of(0x01, 0x02))
    expect(Array.from(chip.read(2))).toEqual([0xde, 0xad])
  })

  it('treats a write too short to carry an address as a probe', () => {
    const chip = createMemoryChip(wideDecl)
    chip.write(Uint8Array.of(0x01, 0x02))
    expect(chip.pointer()).toBe(0x102)
    // One byte cannot address a two-byte part: acknowledged, pointer unmoved.
    expect(chip.write(Uint8Array.of(0x07))).toBe(true)
    expect(chip.pointer()).toBe(0x102)
    expect(chip.write(new Uint8Array(0))).toBe(true)
    expect(chip.pointer()).toBe(0x102)
  })

  it('wraps the pointer at the end of the device', () => {
    const chip = createAt24({ size: 4 })
    chip.write(Uint8Array.of(0x03, 0xaa, 0xbb))
    expect(chip.memory[3]).toBe(0xaa)
    expect(chip.memory[0]).toBe(0xbb) // wrapped
  })

  it('starts erased, and erase() puts it back', () => {
    const chip = createAt24()
    expect(chip.memory.every((b) => b === 0xff)).toBe(true)
    chip.write(Uint8Array.of(0x00, 1, 2, 3))
    expect(chip.memory[0]).toBe(1)
    chip.erase()
    expect(chip.memory.every((b) => b === 0xff)).toBe(true)
  })

  it('pokes a byte from the page, ignoring out-of-range offsets', () => {
    const chip = createAt24()
    chip.poke(0x10, 0x5a)
    expect(chip.memory[0x10]).toBe(0x5a)
    // The guest sees it through a normal read.
    chip.write(Uint8Array.of(0x10))
    expect(Array.from(chip.read(1))).toEqual([0x5a])

    chip.poke(-1, 0)
    chip.poke(9999, 0)
    expect(chip.memory.length).toBe(256)
  })

  it('reports the pointer the next read will use', () => {
    const chip = createAt24()
    chip.write(Uint8Array.of(0x20))
    expect(chip.pointer()).toBe(0x20)
    chip.read(4)
    expect(chip.pointer()).toBe(0x24)
  })

  it('bumps a version and notifies on every change', () => {
    const chip = createAt24()
    const fn = vi.fn()
    const off = chip.subscribe(fn)
    const before = chip.version()

    chip.write(Uint8Array.of(0x00, 0xaa))
    chip.read(1)
    chip.poke(0x05, 1)
    chip.erase()

    expect(fn).toHaveBeenCalledTimes(4)
    expect(chip.version()).toBeGreaterThan(before)

    off()
    chip.poke(0x06, 2)
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('does not notify when a poke changes nothing', () => {
    const chip = createAt24()
    const fn = vi.fn()
    chip.subscribe(fn)
    chip.poke(0x00, 0xff) // already erased
    expect(fn).not.toHaveBeenCalled()
  })

  it('recognises memory parts without claiming the display or a sensor', () => {
    expect(isMemoryChip(createAt24())).toBe(true)
    // The SSD1306 exposes GDDRAM as `memory` but is a display, not storage.
    expect(isMemoryChip(createSsd1306())).toBe(false)
    expect(isMemoryChip(createTmp112())).toBe(false)
  })
})

/** Minimal Storage for the node test environment. */
class MemoryStorage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

describe('memory chip persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reloads written bytes from localStorage under persistKey', () => {
    const key = 'zephyr.eeprom.test'
    const first = createAt24({ persistKey: key })
    first.write(Uint8Array.of(0x00, 0xee, 0x97, 0x03, 0x01))

    // A fresh chip with the same key is a page reload.
    const second = createAt24({ persistKey: key })
    expect(Array.from(second.memory.slice(0, 5))).toEqual([0xee, 0x97, 0x03, 0x01, 0xff])
    expect(localStorage.getItem(key)).toMatch(/^[0-9a-f]+$/)
    expect(localStorage.getItem(key)!.length).toBe(512)
  })

  it('does not rewrite storage on a read (pointer-only change)', () => {
    const key = 'zephyr.eeprom.test-read'
    const chip = createAt24({ persistKey: key })
    chip.write(Uint8Array.of(0x00, 0xaa))
    const before = localStorage.getItem(key)
    const setItem = vi.spyOn(localStorage, 'setItem')
    chip.write(Uint8Array.of(0x00)) // seek
    chip.read(4)
    expect(setItem).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe(before)
  })

  it('erase() drops the storage key so a blank part stays blank', () => {
    const key = 'zephyr.eeprom.test-erase'
    const chip = createAt24({ persistKey: key })
    chip.poke(0, 0x42)
    expect(localStorage.getItem(key)).not.toBeNull()
    chip.erase()
    expect(localStorage.getItem(key)).toBeNull()

    const again = createAt24({ persistKey: key })
    expect(again.memory.every((b) => b === 0xff)).toBe(true)
  })

  it('ignores a corrupt or wrong-length image', () => {
    const key = 'zephyr.eeprom.test-corrupt'
    localStorage.setItem(key, 'deadbeef') // too short
    const chip = createAt24({ persistKey: key })
    expect(chip.memory.every((b) => b === 0xff)).toBe(true)
  })
})
