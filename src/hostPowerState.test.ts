import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attach, available, detach, getSnapshot, subscribe } from './hostPowerState'
import { HOST_POLL_MS } from './hostPoll'

/**
 * The status block's layout, spelled out again rather than imported: this is
 * the contract with hw/misc/esp32c3_rtc_cntl.c. Byte offsets.
 */
const AREA = {
  magic: 0,
  version: 4,
  state: 8,
  resetReason: 12,
  sleepCount: 16,
  rejectCount: 20,
  wakeCause: 24,
  lastSleepUs: 28,
  totalSleepUs: 32,
  ticksLow: 36,
  ticksHigh: 40,
} as const

const AREA_MAGIC = 0x53435452
const BASE = 2048

const AWAKE = 0
const LIGHT_SLEEP = 1
const DEEP_SLEEP = 2

describe('hostPowerState', () => {
  let heap: Uint8Array
  let words: Int32Array

  const set = (offset: number, value: number) => {
    words[(BASE + offset) >> 2] = value
  }

  beforeEach(() => {
    vi.useFakeTimers()
    const buffer = new ArrayBuffer(8192)
    heap = new Uint8Array(buffer)
    words = new Int32Array(buffer)
    set(AREA.magic, AREA_MAGIC)
    set(AREA.version, 1)
    set(AREA.resetReason, 1)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    attach({ _qemu_esp32c3_rtc_status: () => BASE, HEAPU8: heap })
  })

  afterEach(() => {
    detach()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('binds to a status block whose magic checks out', () => {
    expect(available()).toBe(true)
    expect(getSnapshot().state).toBe('awake')
    expect(getSnapshot().resetReason).toBe('Power-on')
  })

  it('refuses a block that is not one', () => {
    detach()
    set(AREA.magic, 0xdead)
    attach({ _qemu_esp32c3_rtc_status: () => BASE, HEAPU8: heap })
    expect(available()).toBe(false)
  })

  it('follows the guest into light sleep and back out', () => {
    set(AREA.state, LIGHT_SLEEP)
    set(AREA.sleepCount, 1)
    set(AREA.lastSleepUs, 54_000)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(getSnapshot().state).toBe('light-sleep')
    expect(getSnapshot().lastSleepUs).toBe(54_000)

    set(AREA.state, AWAKE)
    set(AREA.totalSleepUs, 54_000)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(getSnapshot().state).toBe('awake')
    expect(getSnapshot().totalSleepUs).toBe(54_000)
  })

  it('names the reset reason a deep sleep leaves behind', () => {
    set(AREA.state, DEEP_SLEEP)
    set(AREA.resetReason, 5)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(getSnapshot().state).toBe('deep-sleep')
    expect(getSnapshot().resetReason).toBe('Deep sleep')
  })

  it('keeps the whole 48-bit RTC counter', () => {
    // Low word alone wraps every few hours of guest time; a card that showed
    // only that would jump backwards.
    set(AREA.ticksLow, 0)
    set(AREA.ticksHigh, 1)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(getSnapshot().rtcTicks).toBe(2 ** 32)
  })

  it('notifies only when something actually changed', () => {
    const seen = vi.fn()
    const stop = subscribe(seen)
    vi.advanceTimersByTime(HOST_POLL_MS * 3)
    expect(seen).not.toHaveBeenCalled()

    set(AREA.sleepCount, 7)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
  })

  it('goes quiet when the machine goes away', () => {
    detach()
    expect(available()).toBe(false)
    expect(getSnapshot().state).toBe('awake')
  })
})
