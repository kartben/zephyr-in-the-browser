/**
 * Browser end of the SoC's watchdogs, for the dock's watchdog card.
 *
 * A running watchdog is invisible. The guest prints "Feeding watchdog..." and
 * some time later the part reboots, with nothing in between to say how close
 * it came, which stage it had reached, or afterwards that it was the watchdog
 * at all rather than a crash. The card shows the countdown while it runs and
 * the bite after the reset.
 *
 * Like src/hostPowerState.ts this is a read-only window onto a block the model
 * keeps up to date (`hw/timer/esp_timg.c` in the ESP32 QEMU fork): no protocol,
 * just a read on the shared beat. Two differences:
 *
 * - Fields that go together (a deadline and the clock it is measured against)
 *   are guarded by a per-slot seqlock, since QEMU writes while the page reads.
 * - The countdown is measured against the guest's own clock, which the model
 *   republishes every 20 ms of virtual time while a watchdog runs. Under
 *   `-icount` on the TCI interpreter guest time runs slower than the wall's
 *   whenever the guest is busy, so a wall-clock countdown would reach zero
 *   well before the watchdog does.
 */

import { HOST_POLL_MS, register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'

/** Byte offsets into ESPWdtStatus / ESPWdtStatusSlot. Must match esp_timg.c. */
const HEADER = {
  magic: 0,
  version: 4,
  slotCount: 8,
  slotSize: 12,
  slots: 16,
} as const

const SLOT = {
  seq: 0,
  present: 4,
  index: 8,
  enabled: 12,
  stage: 16,
  actions: 20,
  freqHz: 24,
  stageTicks: 28, // four words
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

const STATUS_MAGIC = 0x53544457 /* "WDTS" */
const STATUS_VERSION = 1
const STAGE_COUNT = 4
/** Retries before a slot being rewritten is left for the next beat. */
const SEQLOCK_TRIES = 4

/** ESPWdtStageConf. */
export type StageAction = 'off' | 'interrupt' | 'reset-cpu' | 'reset-system'
const ACTIONS: StageAction[] = ['off', 'interrupt', 'reset-cpu', 'reset-system']

export interface WatchdogStage {
  action: StageAction
  /** Timeout of this stage, in milliseconds of guest time. */
  timeoutMs: number
}

export interface WatchdogBite {
  /** How many resets this watchdog has caused since the emulator started. */
  count: number
  action: StageAction
  stage: number
  /** Guest time since the last bite, in milliseconds. */
  agoMs: number
}

export interface WatchdogTimer {
  /** Timer group index: 0 is TIMG0's MWDT. */
  index: number
  enabled: boolean
  /** Stage the counter is in now, 0-3. */
  stage: number
  stages: WatchdogStage[]
  /** Guest time left in the current stage, or null when nothing is armed. */
  remainingMs: number | null
  /** Feeds since the last reset. */
  feeds: number
  /** Interrupt stages reached since the emulator started. */
  interrupts: number
  /** The last reset this watchdog caused, or null if it never has. */
  lastBite: WatchdogBite | null
}

export interface WatchdogSnapshot {
  available: boolean
  timers: WatchdogTimer[]
}

const IDLE: WatchdogSnapshot = { available: false, timers: [] }

const POLL_ID = 'host-watchdog'

interface WatchdogExports {
  _qemu_esp_wdt_status?: () => number
  HEAPU8?: Uint8Array
}

let mod: WatchdogExports | null = null
let base = 0
let slotCount = 0
let slotSize = 0
let words: Int32Array | null = null
let snapshot: WatchdogSnapshot = IDLE
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function word(offset: number): number {
  return words![offset >> 2]! >>> 0
}

function ns(lo: number, hi: number): number {
  return hi * 2 ** 32 + lo
}

/** One consistent read of a slot, or null if QEMU kept rewriting it. */
function readSlot(at: number): WatchdogTimer | null {
  for (let tries = 0; tries < SEQLOCK_TRIES; tries++) {
    const before = Atomics.load(words!, at >> 2) >>> 0
    if (before & 1) continue
    const w = (field: number) => word(at + field)

    const freq = w(SLOT.freqHz)
    const actions = w(SLOT.actions)
    const stages: WatchdogStage[] = []
    for (let i = 0; i < STAGE_COUNT; i++) {
      const ticks = w(SLOT.stageTicks + 4 * i)
      stages.push({
        action: ACTIONS[(actions >> (2 * i)) & 3]!,
        timeoutMs: freq > 0 ? (ticks * 1000) / freq : 0,
      })
    }
    const deadline = ns(w(SLOT.deadlineLo), w(SLOT.deadlineHi))
    const now = ns(w(SLOT.nowLo), w(SLOT.nowHi))
    const enabled = w(SLOT.enabled) !== 0
    const bites = w(SLOT.bites)
    const timer: WatchdogTimer = {
      index: w(SLOT.index),
      enabled,
      stage: w(SLOT.stage),
      stages,
      remainingMs: enabled && deadline > 0 ? Math.max(0, (deadline - now) / 1e6) : null,
      feeds: w(SLOT.feeds),
      interrupts: w(SLOT.interrupts),
      lastBite:
        bites > 0
          ? {
              count: bites,
              action: ACTIONS[w(SLOT.biteAction) & 3]!,
              stage: w(SLOT.biteStage),
              agoMs: Math.max(0, (now - ns(w(SLOT.biteLo), w(SLOT.biteHi))) / 1e6),
            }
          : null,
    }

    if ((Atomics.load(words!, at >> 2) >>> 0) === before) return timer
  }
  return null
}

function sameTimer(a: WatchdogTimer, b: WatchdogTimer): boolean {
  return (
    a.index === b.index &&
    a.enabled === b.enabled &&
    a.stage === b.stage &&
    a.remainingMs === b.remainingMs &&
    a.feeds === b.feeds &&
    a.interrupts === b.interrupts &&
    a.lastBite?.count === b.lastBite?.count &&
    a.lastBite?.agoMs === b.lastBite?.agoMs &&
    a.stages.every(
      (s, i) => s.action === b.stages[i]!.action && s.timeoutMs === b.stages[i]!.timeoutMs,
    )
  )
}

function sample() {
  if (!words) {
    discover()
    return
  }
  const timers: WatchdogTimer[] = []
  for (let i = 0; i < slotCount; i++) {
    const at = base + HEADER.slots + i * slotSize
    if (word(at + SLOT.present) === 0) continue
    // A slot mid-update keeps its previous value for one more beat.
    const timer = readSlot(at) ?? snapshot.timers.find((t) => t.index === i)
    if (timer) timers.push(timer)
  }
  const prev = snapshot
  if (
    prev.available &&
    prev.timers.length === timers.length &&
    prev.timers.every((t, i) => sameTimer(t, timers[i]!))
  ) {
    return
  }
  snapshot = { available: true, timers }
  notify()
}

function discover() {
  const at = mod?._qemu_esp_wdt_status?.() ?? 0
  const heap = mod?.HEAPU8
  if (!at || !heap) return

  const view = new Int32Array(heap.buffer)
  if ((view[at >> 2]! >>> 0) !== STATUS_MAGIC) {
    console.warn('[watchdog] status block has the wrong magic; ignoring it')
    mod = null
    return
  }
  const version = view[(at + HEADER.version) >> 2]!
  if (version !== STATUS_VERSION) {
    console.warn(`[watchdog] emulator speaks protocol ${version}, page speaks ${STATUS_VERSION}`)
    mod = null
    return
  }
  base = at
  slotCount = view[(at + HEADER.slotCount) >> 2]!
  slotSize = view[(at + HEADER.slotSize) >> 2]!
  words = view
  sample()
}

/** Called by the qemu backend once its module is live. */
export function attach(instance: unknown) {
  detach()
  mod = instance as WatchdogExports | null
  registerPoll(POLL_ID, HOST_POLL_MS, sample)
  discover()
}

export function detach() {
  unregisterPoll(POLL_ID)
  const was = snapshot.available
  mod = null
  words = null
  base = 0
  slotCount = 0
  slotSize = 0
  snapshot = IDLE
  if (was) notify()
}

export function getSnapshot(): WatchdogSnapshot {
  return snapshot
}

export function available(): boolean {
  return snapshot.available
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Which timer group a devicetree watchdog node is, by its register address.
 * The model's slots are numbered by timer group and know nothing of the
 * devicetree, so the page matches them here. ESP32-C3 addresses: the MWDT
 * registers start 0x48 into each group.
 */
const ESP32C3_MWDT_BASES = [0x6001f048, 0x60020048]

export function timerIndexForAddress(address: number | undefined): number | undefined {
  if (address === undefined) return undefined
  const index = ESP32C3_MWDT_BASES.indexOf(address)
  return index < 0 ? undefined : index
}
