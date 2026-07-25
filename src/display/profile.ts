/**
 * Lightweight display-path profiler for the accel-chart lag hunt.
 *
 * Enable with `?profile=1` (or `window.__zephyrProfile.enable()`). Exposes
 * `window.__zephyrProfile.snapshot()` with rates the Playwright harness reads.
 * Costs next to nothing when disabled; when on, samples on a 250 ms tick.
 */

import { getFrame, getSnapshot, subscribe as subscribeDisplay } from '@/hostDisplay'
import { getSnapshot as getStats } from '@/guestStats'
import { i2cModel } from '@/virtio'
import type { MainToWorker } from '@/display/renderWorker'

export interface ProfileSnapshot {
  wallMs: number
  /** Unique ramfb frames observed / second (guest paint rate). */
  guestFps: number
  /** Texture uploads reported by the render worker / second. */
  uploadFps: number
  /** Mean digest cost in the worker, ms (0 when hot-path skips it). */
  digestMs: number
  /** Mean upload+draw cost in the worker, ms. */
  drawMs: number
  /** I²C transactions / second. */
  i2cHz: number
  /** Guest MIPS (ema). */
  mips: number
  display: { width: number; height: number; available: boolean }
  notes: string[]
}

interface Counters {
  guestFrames: number
  uploads: number
  digestMsSum: number
  digestCount: number
  drawMsSum: number
  drawCount: number
  i2cStart: number
}

const empty = (): Counters => ({
  guestFrames: 0,
  uploads: 0,
  digestMsSum: 0,
  digestCount: 0,
  drawMsSum: 0,
  drawCount: 0,
  i2cStart: 0,
})

let enabled = false
let lastDigest = 0
let hasDigest = false
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
  digestMs: 0,
  drawMs: 0,
  i2cHz: 0,
  mips: 0,
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
  const frame = getFrame()
  if (!frame || frame.byteLength < 4) return
  if (snap.pointer % 4 !== 0 || frame.byteLength % 4 !== 0) return
  /**
 * Sparse FNV over every 4th pixel — thin chart strokes are easy to miss at
 * coarser strides, which made a live-but-flat trace report guestFps=0.
 */
  const words = new Uint32Array(frame.buffer, frame.byteOffset, frame.byteLength / 4)
  let hash = 0x811c9dc5
  for (let i = 0; i < words.length; i += 4) hash = Math.imul(hash ^ words[i], 0x01000193)
  if (hasDigest && hash === lastDigest) return
  lastDigest = hash
  hasDigest = true
  windowCounters.guestFrames += 1
}

/** Called from DisplayPanel when the render worker reports timing. */
export function recordWorkerFrame(stats: {
  uploaded: boolean
  digestMs?: number
  drawMs?: number
}) {
  if (!enabled) return
  if (stats.digestMs !== undefined && stats.digestMs > 0) {
    windowCounters.digestMsSum += stats.digestMs
    windowCounters.digestCount += 1
  }
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
  const notes: string[] = []
  const guestFps = c.guestFrames / elapsed
  const uploadFps = c.uploads / elapsed
  if (guestFps < 8) notes.push('guest_fps_low')
  if (uploadFps + 0.5 < guestFps) notes.push('uploads_behind_guest')
  if (i2cDelta / elapsed > 40) notes.push('i2c_hot')
  if (c.digestCount && c.digestMsSum / c.digestCount > 0.5) notes.push('digest_expensive')

  lastSnapshot = {
    wallMs: now,
    guestFps,
    uploadFps,
    digestMs: c.digestCount ? c.digestMsSum / c.digestCount : 0,
    drawMs: c.drawCount ? c.drawMsSum / c.drawCount : 0,
    i2cHz: i2cDelta / elapsed,
    mips: stats.mips,
    display: {
      width: display.width,
      height: display.height,
      available: display.available,
    },
    notes,
  }
  windowStart = now
  windowCounters = empty()
  windowCounters.i2cStart = i2cNow
}

function enable() {
  if (enabled) return
  enabled = true
  windowStart = performance.now()
  windowCounters = empty()
  windowCounters.i2cStart = i2cModel.transactionCount()
  hasDigest = false
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
