import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimStashed,
  clear,
  get,
  looksLikeElf,
  set,
  stash,
} from './guestImage'
import { installFakeIndexedDb } from './testing/fakeIndexedDb'

describe('guestImage', () => {
  beforeEach(async () => {
    installFakeIndexedDb()
    await clear()
  })

  afterEach(async () => {
    await clear()
    vi.unstubAllGlobals()
  })

  it('recognises ELF magic', () => {
    expect(looksLikeElf(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0]))).toBe(true)
    expect(looksLikeElf(new Uint8Array([0, 1, 2, 3]))).toBe(false)
  })

  it('keeps a stashed ELF available after claim so Reload can reclaim it', async () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 9, 8, 7])
    await stash({ name: 'custom.elf', bytes })

    const first = await claimStashed()
    expect(first?.name).toBe('custom.elf')
    expect(Array.from(get()!.bytes)).toEqual(Array.from(bytes))

    // Second claim without clear: the Reload case — IndexedDB row must remain.
    const again = await claimStashed()
    expect(again?.name).toBe('custom.elf')
    expect(Array.from(again!.bytes)).toEqual(Array.from(bytes))
  })

  it('persists set() so a soft boot still survives a later hard Reload', async () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1])
    set({ name: 'soft.elf', bytes })
    await vi.waitFor(async () => {
      const claimed = await claimStashed()
      expect(claimed?.name).toBe('soft.elf')
    })
  })

  it('forgets the ELF from IndexedDB on clear', async () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 4])
    await stash({ name: 'gone.elf', bytes })
    await claimStashed()
    await clear()
    expect(get()).toBeNull()
    expect(await claimStashed()).toBeNull()
  })
})
