import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as serialStore from './serialStore'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
  serialStore.reloadFromStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('serialStore', () => {
  it('starts with no pipes', () => {
    expect(serialStore.getSettings()).toEqual({ uarts: {} })
  })

  it('survives a reload', () => {
    serialStore.setPipe('uart1', { vid: 0x0403, pid: 0x6001, baudRate: 9600, autoReconnect: true })
    serialStore.reloadFromStorage()
    expect(serialStore.getPipe('uart1')).toEqual({
      vid: 0x0403,
      pid: 0x6001,
      baudRate: 9600,
      autoReconnect: true,
    })
  })

  it('clears a pipe', () => {
    serialStore.setPipe('uart1', { baudRate: 9600, autoReconnect: false })
    serialStore.setPipe('uart1', undefined)
    serialStore.reloadFromStorage()
    expect(serialStore.getPipe('uart1')).toBeUndefined()
  })

  it('ignores another version, and records that do not parse', () => {
    localStorage.setItem('zephyr.serial', JSON.stringify({ v: 2, uarts: { uart1: { baudRate: 9600 } } }))
    serialStore.reloadFromStorage()
    expect(serialStore.getPipe('uart1')).toBeUndefined()

    localStorage.setItem('zephyr.serial', '{')
    serialStore.reloadFromStorage()
    expect(serialStore.getSettings()).toEqual({ uarts: {} })
  })

  it('drops a bad baud rate, and half a USB identity', () => {
    localStorage.setItem(
      'zephyr.serial',
      JSON.stringify({ v: 1, uarts: { uart1: { baudRate: 0, vid: 1, pid: 2 } } }),
    )
    serialStore.reloadFromStorage()
    expect(serialStore.getPipe('uart1')).toBeUndefined()

    localStorage.setItem(
      'zephyr.serial',
      JSON.stringify({ v: 1, uarts: { uart1: { baudRate: 9600, vid: 0x0403 } } }),
    )
    serialStore.reloadFromStorage()
    expect(serialStore.getPipe('uart1')).toEqual({ baudRate: 9600, autoReconnect: true })
  })

  it('tells subscribers', () => {
    const fn = vi.fn()
    const off = serialStore.subscribe(fn)
    serialStore.setPipe('uart1', { baudRate: 115200, autoReconnect: true })
    off()
    serialStore.setPipe('uart1', undefined)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
