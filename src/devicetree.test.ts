import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimStashedDts,
  clear,
  clearStashedDts,
  get,
  loadSampleDts,
  setUserDts,
  stashUserDts,
  subscribe,
} from './devicetree'
import a53Shell from './dts/fixtures/qemu_cortex_a53_shell.dts?raw'
import { installFakeIndexedDb } from './testing/fakeIndexedDb'

afterEach(async () => {
  await clear()
  vi.unstubAllGlobals()
})

describe('devicetree store', () => {
  it('parses a user devicetree into insights', () => {
    setUserDts('zephyr.dts', a53Shell)
    const state = get()
    expect(state?.source).toBe('user')
    expect(state?.name).toBe('zephyr.dts')
    expect(state?.doc).not.toBeNull()
    expect(state?.insights?.i2cBuses[0]?.slots).toHaveLength(11)
  })

  it('keeps the text but nulls the rest when parsing fails', () => {
    setUserDts('broken.dts', '/dts-v1/; / { unterminated')
    const state = get()
    expect(state?.text).toContain('unterminated')
    expect(state?.doc).toBeNull()
    expect(state?.insights).toBeNull()
  })

  it('lets a user devicetree outrank a slower in-flight sample fetch', async () => {
    // The sample's .dts can be queued behind multi-MB emulator assets; a user
    // ELF+DTS dropped in that window must not be clobbered when it lands.
    let release!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      () => new Promise<Response>((resolve) => (release = resolve)),
    )

    const pending = loadSampleDts('/qemu/zephyr/qemu_cortex_m3/shell.dts', 'shell.dts')
    setUserDts('zephyr.dts', a53Shell)

    release(new Response('/dts-v1/; / { };', { headers: { 'content-type': 'text/plain' } }))
    await pending

    expect(get()?.source).toBe('user')
    expect(get()?.name).toBe('zephyr.dts')
  })

  it('notifies subscribers on set and clear', async () => {
    let calls = 0
    const unsubscribe = subscribe(() => calls++)
    setUserDts('zephyr.dts', a53Shell)
    expect(calls).toBe(1)
    await clear()
    expect(calls).toBe(2)
    await clear() // already clear — no spurious notification
    expect(calls).toBe(2)
    unsubscribe()
  })

  describe('session persistence', () => {
    beforeEach(async () => {
      installFakeIndexedDb()
      await clearStashedDts()
      await clear()
    })

    it('keeps a stashed user DTS available after claim so Reload can reclaim it', async () => {
      await stashUserDts('zephyr.dts', a53Shell)
      await claimStashedDts()
      expect(get()?.name).toBe('zephyr.dts')
      expect(get()?.source).toBe('user')

      // Reload: claim again without clearing — row must still be there.
      await claimStashedDts()
      expect(get()?.name).toBe('zephyr.dts')
    })

    it('forgets the DTS from IndexedDB on clear', async () => {
      await stashUserDts('zephyr.dts', a53Shell)
      await claimStashedDts()
      await clear()
      expect(get()).toBeNull()
      await claimStashedDts()
      expect(get()).toBeNull()
    })
  })
})
