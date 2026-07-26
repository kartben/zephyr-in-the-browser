/** Browser side of the guest instruction-counter / warp stats export. */

interface StatsExports {
  _qemu_browser_guest_icount?: () => number
  /**
   * Measures extra real time between an icount sleep deadline being armed and
   * firing; independent of virtio I/O.
   */
  _qemu_icount_warp_overshoot_avg_ns?: () => number
  _qemu_icount_warp_overshoot_max_ns?: () => number
  _qemu_icount_warp_overshoot_count?: () => number
}

export interface WarpOvershootStats {
  avgNs: number
  maxNs: number
  count: number
}

export function warpOvershootStats(): WarpOvershootStats | null {
  const fn = exports?._qemu_icount_warp_overshoot_avg_ns
  if (typeof fn !== 'function') return null
  return {
    avgNs: fn(),
    maxNs: exports?._qemu_icount_warp_overshoot_max_ns?.() ?? -1,
    count: exports?._qemu_icount_warp_overshoot_count?.() ?? 0,
  }
}

export interface StatsSnapshot {
  available: boolean
  mips: number
  peakMips: number
  history: readonly number[]
}

const HISTORY = 48
const POLL_MS = 500
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

/**
 * Must match `-icount shift=N` on the A53 board in `boards.ts`. QEMU virtual
 * time is `icount << shift` nanoseconds; we only export the instruction count.
 */
const ICOUNT_SHIFT = 4

function readCount(): number | null {
  const fn = exports?._qemu_browser_guest_icount
  if (typeof fn !== 'function') return null
  const value = fn()
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Instruction time, not full QEMU virtual time; sleep warps are missing. Use
 * wall clock for charts where the guest blocks on virtio I/O.
 */
export function guestVirtualNowMs(): number | null {
  const count = readCount()
  if (count === null) return null
  return (count * 2 ** ICOUNT_SHIFT) / 1e6
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
