/**
 * Lightweight display-path profiler for the accel-chart lag hunt.
 *
 * Enable with `?profile=1` (or `window.__zephyrProfile.enable()`). Exposes
 * `window.__zephyrProfile.snapshot()` and mirrors the snapshot into
 * `<html data-zephyr-profile>` for browser harnesses that run in an isolated
 * JavaScript world. Costs next to nothing when disabled; when on, samples on
 * a 250 ms tick.
 */

import {
  getFrameSequence,
  getSnapshot,
  subscribe as subscribeDisplay,
} from '@/hostDisplay'
import { getSnapshot as getStats, warpOvershootStats } from '@/guestStats'
import {
  bridgeStats,
  i2cModel,
  wakeLatencyStats,
  notifySourceStats,
  type BridgeStats,
} from '@/virtio'
import type { MainToWorker } from '@/display/renderWorker'

export interface ProfileSnapshot {
  wallMs: number
  /** Unique ramfb frames observed / second (guest paint rate). */
  guestFps: number
  /** Texture uploads reported by the render worker / second. */
  uploadFps: number
  /** Render-worker checks / second, including idle atomic reads. */
  workerFps: number
  /** Mean synchronous worker cost per check, ms. */
  workerMs: number
  /** Mean upload+draw cost in the worker, ms. */
  drawMs: number
  /** I²C transactions / second. */
  i2cHz: number
  /** Virtio requests drained / second, across every bound device. */
  bridgeHz: number
  /** Atomic request notifications delivered by the waiter worker / second. */
  bridgeWakeHz: number
  /** Guest MIPS (ema). */
  mips: number
  /**
   * Diagnostic: mean/max ns from virtio_notify() to the RR vCPU thread
   * resuming, and how many samples that average is over. Cumulative since
   * boot (QEMU-side counters, not windowed). -1/0 on riscv32 and xtensa: they
   * are patched from tools/qemu-esp-patches/, which carries no diagnostics
   * patches, so the exports are absent by construction rather than by vintage.
   * See docs/performance.md item 7.
   */
  wakeAvgNs: number
  wakeMaxNs: number
  wakeCount: number
  /** Diagnostic: mean/max ns a guest timer deadline overshoots by (icount warp). */
  warpOvershootAvgNs: number
  warpOvershootMaxNs: number
  warpOvershootCount: number
  /** Diagnostic: completions delivered via the kick BH vs the periodic timer. */
  notifyViaKick: number
  notifyViaTimer: number
  display: { width: number; height: number; available: boolean }
  notes: string[]
}

interface Counters {
  guestFrames: number
  uploads: number
  workerChecks: number
  workerMsSum: number
  drawMsSum: number
  drawCount: number
  i2cStart: number
  /** Bridge counters as they stood when the window opened; free-running. */
  bridgeStart: BridgeStats
}

const ZERO_BRIDGE: BridgeStats = {
  requests: 0,
  kicks: 0,
  waiterWakeups: 0,
}

const empty = (): Counters => ({
  guestFrames: 0,
  uploads: 0,
  workerChecks: 0,
  workerMsSum: 0,
  drawMsSum: 0,
  drawCount: 0,
  i2cStart: 0,
  bridgeStart: ZERO_BRIDGE,
})

let enabled = false
let lastFrameSequence = 0
let hasFrameSequence = false
let poll: ReturnType<typeof setInterval> | undefined
let unsubDisplay: (() => void) | undefined
let raf = 0
let windowStart = 0
let windowCounters = empty()
let renderWorker: Worker | null = null
let lastSnapshot: ProfileSnapshot = {
  wallMs: 0,
  guestFps: 0,
  uploadFps: 0,
  workerFps: 0,
  workerMs: 0,
  drawMs: 0,
  i2cHz: 0,
  bridgeHz: 0,
  bridgeWakeHz: 0,
  mips: 0,
  wakeAvgNs: -1,
  wakeMaxNs: -1,
  wakeCount: 0,
  warpOvershootAvgNs: -1,
  warpOvershootMaxNs: -1,
  warpOvershootCount: 0,
  notifyViaKick: 0,
  notifyViaTimer: 0,
  display: { width: 0, height: 0, available: false },
  notes: [],
}

/** DisplayPanel registers the live worker so profile mode can toggle it. */
export function setRenderWorker(worker: Worker | null) {
  renderWorker = worker
  if (enabled && worker) {
    const msg: MainToWorker = { type: 'profile', enabled: true }
    worker.postMessage(msg)
  }
}

function sampleGuestFrame() {
  const snap = getSnapshot()
  if (!snap.available) return
  const sequence = getFrameSequence()
  if (sequence === null) return
  if (hasFrameSequence && sequence === lastFrameSequence) return
  lastFrameSequence = sequence
  hasFrameSequence = true
  windowCounters.guestFrames += 1
}

/** Called from DisplayPanel when the render worker reports timing. */
export function recordWorkerFrame(stats: {
  uploaded: boolean
  drawMs?: number
  checkMs?: number
}) {
  if (!enabled) return
  windowCounters.workerChecks += 1
  if (stats.checkMs !== undefined) windowCounters.workerMsSum += stats.checkMs
  if (!stats.uploaded) return
  windowCounters.uploads += 1
  if (stats.drawMs !== undefined) {
    windowCounters.drawMsSum += stats.drawMs
    windowCounters.drawCount += 1
  }
}

function rollWindow() {
  const now = performance.now()
  const elapsed = Math.max(0.001, (now - windowStart) / 1000)
  const c = windowCounters
  const display = getSnapshot()
  const stats = getStats()
  const i2cNow = i2cModel.transactionCount()
  const i2cDelta = Math.max(0, i2cNow - c.i2cStart)
  const bridgeNow = bridgeStats()
  const notes: string[] = []
  const guestFps = c.guestFrames / elapsed
  const uploadFps = c.uploads / elapsed
  if (guestFps < 8) notes.push('guest_fps_low')
  if (uploadFps + 0.5 < guestFps) notes.push('uploads_behind_guest')
  if (i2cDelta / elapsed > 40) notes.push('i2c_hot')
  const wake = wakeLatencyStats()
  const warp = warpOvershootStats()
  const notifySource = notifySourceStats()

  lastSnapshot = {
    wallMs: now,
    guestFps,
    uploadFps,
    workerFps: c.workerChecks / elapsed,
    workerMs: c.workerChecks ? c.workerMsSum / c.workerChecks : 0,
    drawMs: c.drawCount ? c.drawMsSum / c.drawCount : 0,
    i2cHz: i2cDelta / elapsed,
    bridgeHz: Math.max(0, bridgeNow.requests - c.bridgeStart.requests) / elapsed,
    bridgeWakeHz:
      Math.max(0, bridgeNow.waiterWakeups - c.bridgeStart.waiterWakeups) / elapsed,
    mips: stats.mips,
    wakeAvgNs: wake?.avgNs ?? -1,
    wakeMaxNs: wake?.maxNs ?? -1,
    wakeCount: wake?.count ?? 0,
    warpOvershootAvgNs: warp?.avgNs ?? -1,
    warpOvershootMaxNs: warp?.maxNs ?? -1,
    warpOvershootCount: warp?.count ?? 0,
    notifyViaKick: notifySource?.viaKick ?? 0,
    notifyViaTimer: notifySource?.viaTimer ?? 0,
    display: {
      width: display.width,
      height: display.height,
      available: display.available,
    },
    notes,
  }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.zephyrProfile = JSON.stringify(lastSnapshot)
  }
  windowStart = now
  windowCounters = empty()
  windowCounters.i2cStart = i2cNow
  windowCounters.bridgeStart = bridgeNow
}

function enable() {
  if (enabled) return
  enabled = true
  windowStart = performance.now()
  windowCounters = empty()
  windowCounters.i2cStart = i2cModel.transactionCount()
  windowCounters.bridgeStart = bridgeStats()
  hasFrameSequence = false
  const tick = () => {
    if (!enabled) return
    sampleGuestFrame()
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  poll = setInterval(rollWindow, 250)
  unsubDisplay = subscribeDisplay(() => sampleGuestFrame())
  if (renderWorker) {
    const msg: MainToWorker = { type: 'profile', enabled: true }
    renderWorker.postMessage(msg)
  }
}

function disable() {
  if (!enabled) return
  enabled = false
  if (poll !== undefined) clearInterval(poll)
  poll = undefined
  unsubDisplay?.()
  cancelAnimationFrame(raf)
  if (renderWorker) {
    const msg: MainToWorker = { type: 'profile', enabled: false }
    renderWorker.postMessage(msg)
  }
  if (typeof document !== 'undefined') delete document.documentElement.dataset.zephyrProfile
}

function snapshot(): ProfileSnapshot {
  return { ...lastSnapshot, display: { ...lastSnapshot.display }, notes: [...lastSnapshot.notes] }
}

export const profile = {
  enable,
  disable,
  snapshot,
  recordWorkerFrame,
  get enabled() {
    return enabled
  },
}

declare global {
  interface Window {
    __zephyrProfile?: typeof profile
  }
}

/** Install the console/Playwright handle; auto-enable when ?profile=1. */
export function installProfile() {
  if (typeof window === 'undefined') return
  window.__zephyrProfile = profile
  if (new URLSearchParams(location.search).has('profile')) profile.enable()
}
