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
  /**
   * Diagnostic (tools/qemu-jit-patches/0016-instrument-icount-warp-overshoot.patch):
   * with `sleep=on`, a guest timer deadline is honoured by arming a real
   * QEMU_CLOCK_VIRTUAL_RT timer for exactly that many real ns rather than
   * warping instantly. These read how much *extra* real time that arm-to-fire
   * gap costs beyond the requested deadline — independent of any virtio I/O.
   */
  _qemu_icount_warp_overshoot_avg_ns?: () => number
  _qemu_icount_warp_overshoot_max_ns?: () => number
  _qemu_icount_warp_overshoot_count?: () => number
}

/** Mean/max ns a guest timer deadline overshoots its requested delay by. */
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

/**
 * Must match `-icount shift=N` on the A53 board in `boards.ts`. QEMU virtual
 * time is `icount << shift` nanoseconds; we only export the instruction count.
 */
const ICOUNT_SHIFT = 4

/** The raw guest instruction count, or null when icount is not driving it. */
function readCount(): number | null {
  const fn = exports?._qemu_browser_guest_icount
  if (typeof fn !== 'function') return null
  const value = fn()
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Guest *instruction* time in milliseconds, or null when icount is not
 * driving the machine. Derived from `icount_get_raw() << shift` — that is
 * executed instructions, **not** the full `QEMU_CLOCK_VIRTUAL` (sleep warps
 * under `-icount sleep=on` are missing). Fine for MIPS; misleading as a
 * scope time base while the guest blocks on virtio-i2c (the DAC sawtooth
 * froze at ~2 ms of this counter per wall second). Prefer wall clock for
 * charts of I²C-bound samples.
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
