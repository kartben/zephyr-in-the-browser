import { afterEach, describe, expect, it } from 'vitest'
import { clear, get, setUserDts, subscribe } from './devicetree'
import a53Shell from './dts/fixtures/qemu_cortex_a53_shell.dts?raw'

afterEach(() => clear())

describe('devicetree store', () => {
  it('parses a user devicetree into insights', () => {
    setUserDts('zephyr.dts', a53Shell)
    const state = get()
    expect(state?.source).toBe('user')
    expect(state?.name).toBe('zephyr.dts')
    expect(state?.doc).not.toBeNull()
    expect(state?.insights?.i2cBuses[0]?.slots).toHaveLength(5)
  })

  it('keeps the text but nulls the rest when parsing fails', () => {
    setUserDts('broken.dts', '/dts-v1/; / { unterminated')
    const state = get()
    expect(state?.text).toContain('unterminated')
    expect(state?.doc).toBeNull()
    expect(state?.insights).toBeNull()
  })

  it('notifies subscribers on set and clear', () => {
    let calls = 0
    const unsubscribe = subscribe(() => calls++)
    setUserDts('zephyr.dts', a53Shell)
    expect(calls).toBe(1)
    clear()
    expect(calls).toBe(2)
    clear() // already clear — no spurious notification
    expect(calls).toBe(2)
    unsubscribe()
  })
})
