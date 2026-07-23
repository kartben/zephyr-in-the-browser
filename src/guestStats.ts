/**
 * Browser end of the guest instruction-counter export added to the aarch64 JIT
 * build (tools/qemu-jit-patches/0007-accel-tcg-export-guest-icount.patch).
 *
 * Sampling `qemu_browser_guest_icount()` against `performance.now()` yields the
 * guest's throughput in MIPS — a direct read on how fast the wasm TCG JIT is
 * executing the emulated CPU, and the honest counterpart to the README's
 * "6.5× TCI→JIT" claim.
 *
 * The count only advances on a `-icount` machine (the Cortex-A53 board here), so
 * a build or board without it reads back negative and the panel stays hidden.
 * The QEMU-side read is a cheap, lock-free seqlock read — polling it at a couple
 * of hertz costs nothing and never blocks the emulator.
 */

interface StatsExports {
  _qemu_browser_guest_icount?: () => number
}

export interface StatsSnapshot {
  available: boolean
  /** Millions of guest instructions per wall-clock second, smoothed. */
  mips: number
  /** Highest sustained MIPS this session — context, and sparkline scale. */
  peakMips: number
  /** Recent instantaneous MIPS, oldest → newest, for a sparkline. */
  history: readonly number[]
}

/** ~24 s of history at the poll rate below. */
const HISTORY = 48
const POLL_MS = 500
/** EMA weight for the displayed number: smooth, but tracks a real change fast. */
const EMA_ALPHA = 0.35

const EMPTY: StatsSnapshot = { available: false, mips: 0, peakMips: 0, history: [] }

let exports: StatsExports | null = null
let snapshot = EMPTY
let poll: ReturnType<typeof setInterval> | undefined
let lastCount = -1
let lastTime = 0
let ema = 0
let peak = 0
let history: number[] = []
const listeners = new Set<() => void>()

/** The raw guest instruction count, or null when icount is not driving it. */
function readCount(): number | null {
  const fn = exports?._qemu_browser_guest_icount
  if (typeof fn !== 'function') return null
  const value = fn()
  return Number.isFinite(value) && value >= 0 ? value : null
}

function sample() {
  const count = readCount()
  const now = performance.now()

  if (count === null) {
    if (snapshot !== EMPTY) {
      snapshot = EMPTY
      notify()
    }
    return
  }

  if (lastCount < 0) {
    // First reading only establishes the baseline; a rate needs two samples.
    lastCount = count
    lastTime = now
    snapshot = { available: true, mips: 0, peakMips: 0, history: [] }
    notify()
    return
  }

  const deltaInsn = count - lastCount
  const deltaMs = now - lastTime
  lastCount = count
  lastTime = now
  if (deltaMs <= 0) return

  // instructions / ms / 1000 == millions of instructions / second.
  const instant = Math.max(0, deltaInsn) / deltaMs / 1000
  ema = ema === 0 ? instant : ema + EMA_ALPHA * (instant - ema)
  peak = Math.max(peak, ema)
  history = [...history, instant].slice(-HISTORY)
  snapshot = { available: true, mips: ema, peakMips: peak, history }
  notify()
}

export function attach(mod: unknown) {
  detach()
  exports = mod as StatsExports
  // No export (e.g. the arm/TCI build) means nothing to show: stay quiet, start
  // no interval. A present export begins sampling immediately.
  if (typeof exports._qemu_browser_guest_icount !== 'function') return
  sample()
  poll = setInterval(sample, POLL_MS)
}

export function detach() {
  if (poll !== undefined) clearInterval(poll)
  poll = undefined
  exports = null
  lastCount = -1
  lastTime = 0
  ema = 0
  peak = 0
  history = []
  if (snapshot !== EMPTY) {
    snapshot = EMPTY
    notify()
  }
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): StatsSnapshot {
  return snapshot
}

function notify() {
  for (const fn of listeners) fn()
}
