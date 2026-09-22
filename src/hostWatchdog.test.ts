import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attach, available, detach, getSnapshot, subscribe, watchdogForAddress } from './hostWatchdog'
import { HOST_POLL_MS } from './hostPoll'

/**
 * The status block's layout, spelled out again rather than imported: this is
 * the contract with hw/timer/esp_timg.c in the ESP32 QEMU fork and with
 * hw/watchdog/browser-wdt-status.c in the patch series. Byte offsets.
 */
const HEADER = { magic: 0, version: 4, slotCount: 8, slotSize: 12, slots: 16 } as const
const SLOT = {
  seq: 0,
  present: 4,
  index: 8,
  enabled: 12,
  stage: 16,
  actions: 20,
  freqHz: 24,
  stageTicks: 28,
  feeds: 44,
  interrupts: 48,
  bites: 52,
  biteAction: 56,
  biteStage: 60,
  deadlineLo: 64,
  deadlineHi: 68,
  nowLo: 72,
  nowHi: 76,
  biteLo: 80,
  biteHi: 84,
} as const
const SLOT_SIZE = 88
const SLOTS = 4

const MAGIC = 0x53544457
const BASE = 1024
const MS = 1_000_000

/** Stage 0 interrupts, stage 1 resets the SoC: what Zephyr's driver programs. */
const ZEPHYR_ACTIONS = 1 | (3 << 2)

describe('hostWatchdog', () => {
  let heap: Uint8Array
  let words: Int32Array

  const set = (offset: number, value: number) => {
    words[offset >> 2] = value
  }
  const slot = (n: number, field: number, value: number) =>
    set(BASE + HEADER.slots + n * SLOT_SIZE + field, value)
  const clock = (n: number, lo: number, hi: number, ns: number) => {
    slot(n, lo, ns % 2 ** 32)
    slot(n, hi, Math.floor(ns / 2 ** 32))
  }

  /** TIMG0's WDT as Zephyr leaves it after wdt_setup(): 1 s per stage. */
  const armTimg0 = (nowNs: number, deadlineNs: number) => {
    slot(0, SLOT.enabled, 1)
    slot(0, SLOT.actions, ZEPHYR_ACTIONS)
    slot(0, SLOT.freqHz, 1000)
    slot(0, SLOT.stageTicks, 1000)
    slot(0, SLOT.stageTicks + 4, 1000)
    clock(0, SLOT.nowLo, SLOT.nowHi, nowNs)
    clock(0, SLOT.deadlineLo, SLOT.deadlineHi, deadlineNs)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    const buffer = new ArrayBuffer(8192)
    heap = new Uint8Array(buffer)
    words = new Int32Array(buffer)
    set(BASE + HEADER.magic, MAGIC)
    set(BASE + HEADER.version, 1)
    set(BASE + HEADER.slotCount, SLOTS)
    set(BASE + HEADER.slotSize, SLOT_SIZE)
    for (const n of [0, 1]) {
      slot(n, SLOT.present, 1)
      slot(n, SLOT.index, n)
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    attach({ _qemu_esp_wdt_status: () => BASE, HEAPU8: heap })
  })

  afterEach(() => {
    detach()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('lists every timer group the model claimed, disabled until armed', () => {
    expect(available()).toBe(true)
    const timers = getSnapshot().timers
    expect(timers.map((t) => t.index)).toEqual([0, 1])
    expect(timers[0]).toMatchObject({ enabled: false, remainingMs: null, lastBite: null })
  })

  it('refuses a block that is not one', () => {
    detach()
    set(BASE + HEADER.magic, 0xdead)
    attach({ _qemu_esp_wdt_status: () => BASE, HEAPU8: heap })
    expect(available()).toBe(false)
  })

  it('counts down against the guest clock, not the wall', () => {
    armTimg0(5000 * MS, 5750 * MS)
    vi.advanceTimersByTime(HOST_POLL_MS)
    const t = getSnapshot().timers[0]!
    expect(t.enabled).toBe(true)
    expect(t.remainingMs).toBe(750)
    expect(t.stages.slice(0, 2)).toEqual([
      { action: 'interrupt', timeoutMs: 1000 },
      { action: 'reset-system', timeoutMs: 1000 },
    ])
    expect(t.stages[2]!.action).toBe('off')

    // Plenty of wall time passes; the guest clock does not. Nothing moves.
    vi.advanceTimersByTime(HOST_POLL_MS * 10)
    expect(getSnapshot().timers[0]!.remainingMs).toBe(750)
  })

  it('keeps the whole 64-bit clock', () => {
    // The low word alone wraps every 4.3 s of guest time.
    armTimg0(2 ** 32 + 100 * MS, 2 ** 32 + 400 * MS)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(getSnapshot().timers[0]!.remainingMs).toBe(300)
  })

  it('keeps the last good value while a slot is being written', () => {
    armTimg0(5000 * MS, 5750 * MS)
    vi.advanceTimersByTime(HOST_POLL_MS)

    slot(0, SLOT.seq, 7) // odd: QEMU is mid-update
    clock(0, SLOT.nowLo, SLOT.nowHi, 5100 * MS)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(getSnapshot().timers[0]!.remainingMs).toBe(750)

    slot(0, SLOT.seq, 8)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(getSnapshot().timers[0]!.remainingMs).toBe(650)
  })

  it('remembers a bite across the reset it caused', () => {
    armTimg0(5000 * MS, 5750 * MS)
    vi.advanceTimersByTime(HOST_POLL_MS)

    // The reset disables the WDT and clears feeds; the bite stays.
    slot(0, SLOT.enabled, 0)
    slot(0, SLOT.feeds, 0)
    slot(0, SLOT.bites, 1)
    slot(0, SLOT.biteAction, 3)
    slot(0, SLOT.biteStage, 1)
    clock(0, SLOT.biteLo, SLOT.biteHi, 6000 * MS)
    clock(0, SLOT.nowLo, SLOT.nowHi, 6200 * MS)
    vi.advanceTimersByTime(HOST_POLL_MS)

    const t = getSnapshot().timers[0]!
    expect(t.enabled).toBe(false)
    expect(t.remainingMs).toBeNull()
    expect(t.lastBite).toEqual({ count: 1, action: 'reset-system', stage: 1, agoMs: 200 })
  })

  it('notifies only when something actually changed', () => {
    const seen = vi.fn()
    const stop = subscribe(seen)
    vi.advanceTimersByTime(HOST_POLL_MS * 3)
    expect(seen).not.toHaveBeenCalled()

    slot(0, SLOT.feeds, 3)
    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
  })

  it('goes quiet when the machine goes away', () => {
    detach()
    expect(available()).toBe(false)
    expect(getSnapshot().timers).toEqual([])
  })

  it('reads the upstream models\' block too, and tells the two apart', () => {
    detach()
    // A second block, as the riscv32 binary exports: the ESP32 one above,
    // with its two slots, and the browser one with a single SiFive watchdog.
    const OTHER = 4096
    const at = (field: number) => OTHER + HEADER.slots + field
    set(OTHER + HEADER.magic, MAGIC)
    set(OTHER + HEADER.version, 1)
    set(OTHER + HEADER.slotCount, SLOTS)
    set(OTHER + HEADER.slotSize, SLOT_SIZE)
    set(at(SLOT.present), 1)
    set(at(SLOT.enabled), 1)
    set(at(SLOT.actions), 3) // one stage, and it resets
    set(at(SLOT.freqHz), 32768)
    set(at(SLOT.stageTicks), 32768)
    set(at(SLOT.nowLo), 100 * MS)
    set(at(SLOT.deadlineLo), 350 * MS)
    attach({
      _qemu_esp_wdt_status: () => BASE,
      _qemu_browser_wdt_status: () => OTHER,
      HEAPU8: heap,
    })

    const timers = getSnapshot().timers
    expect(timers.map((t) => `${t.source}:${t.index}`)).toEqual(['esp:0', 'esp:1', 'browser:0'])
    expect(timers[2]).toMatchObject({ enabled: true, remainingMs: 250 })
    expect(timers[2]!.stages[0]).toEqual({ action: 'reset-system', timeoutMs: 1000 })
  })

  it('places devicetree nodes on their status slot by address', () => {
    expect(watchdogForAddress(0x6001f048)).toEqual({ source: 'esp', index: 0 })
    expect(watchdogForAddress(0x60020048)).toEqual({ source: 'esp', index: 1 })
    expect(watchdogForAddress(0x40000000)).toEqual({ source: 'browser', index: 0 })
    expect(watchdogForAddress(0x1000d000)).toEqual({ source: 'browser', index: 0 })
    expect(watchdogForAddress(0x6000_0000)).toBeUndefined()
    expect(watchdogForAddress(undefined)).toBeUndefined()
  })
})
