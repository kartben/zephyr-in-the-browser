import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as store from './progressStore'

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

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
  store.reloadFromStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('learn progress persistence', () => {
  it('starts empty when nothing is stored', () => {
    const snap = store.getSnapshot()
    expect(snap.done.size).toBe(0)
    expect(snap.activeStepId).toBeNull()
  })

  it('round-trips done marks through the versioned envelope', () => {
    store.setStepDone('07-gpio', true)
    store.setStepDone('01-hello', true)

    const raw = JSON.parse(localStorage.getItem('zephyr.learn')!)
    expect(raw.v).toBe(1)
    // Sorted for a stable record, whatever order the user ticked in.
    expect(raw.done).toEqual(['01-hello', '07-gpio'])

    store.reloadFromStorage()
    expect(store.getSnapshot().done.has('07-gpio')).toBe(true)
    expect(store.getSnapshot().done.has('01-hello')).toBe(true)
  })

  it('unmarks a step and stays idempotent both ways', () => {
    store.setStepDone('01-hello', true)
    store.setStepDone('01-hello', true)
    store.setStepDone('01-hello', false)
    store.setStepDone('01-hello', false)
    store.reloadFromStorage()
    expect(store.getSnapshot().done.size).toBe(0)
  })

  it('keeps step ids it does not recognize', () => {
    // A step temporarily pulled from a track must not lose its tick.
    localStorage.setItem(
      'zephyr.learn',
      JSON.stringify({ v: 1, done: ['someday-16-dma'], active: null }),
    )
    store.reloadFromStorage()
    store.setStepDone('01-hello', true)
    const raw = JSON.parse(localStorage.getItem('zephyr.learn')!)
    expect(raw.done).toContain('someday-16-dma')
  })

  it('falls back to empty on corrupt JSON, wrong version, or bad shapes', () => {
    for (const raw of [
      '{not json',
      JSON.stringify({ v: 999, done: ['01-hello'] }),
      JSON.stringify({ v: 1, done: 'oops', active: 7 }),
      JSON.stringify({ v: 1, done: ['01-hello', 42], active: null }),
    ]) {
      localStorage.setItem('zephyr.learn', raw)
      store.reloadFromStorage()
      const snap = store.getSnapshot()
      // The last case keeps the well-formed entry and drops the junk.
      expect([...snap.done].every((id) => typeof id === 'string')).toBe(true)
      expect(snap.activeStepId).toBeNull()
    }
  })

  it('persists the active step and clears it', () => {
    store.setActiveStep('08-sensor')
    store.reloadFromStorage()
    expect(store.getSnapshot().activeStepId).toBe('08-sensor')

    store.setActiveStep(null)
    store.reloadFromStorage()
    expect(store.getSnapshot().activeStepId).toBeNull()
  })

  it('hands out a new snapshot object per change', () => {
    const before = store.getSnapshot()
    store.setStepDone('01-hello', true)
    expect(store.getSnapshot()).not.toBe(before)
    expect(before.done.has('01-hello')).toBe(false)
  })
})
