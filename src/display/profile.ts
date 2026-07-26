import {
  getFrame,
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
  guestFps: number
  uploadFps: number
  workerFps: number
  workerMs: number
  digestMs: number
  drawMs: number
  i2cHz: number
  bridgePollMs: number
  bridgePollSlowPct: number
  bridgeHz: number
  bridgeWakeHz: number
  bridgeWaiterActive: boolean
  mips: number
  wakeAvgNs: number
  wakeMaxNs: number
  wakeCount: number
  warpOvershootAvgNs: number
  warpOvershootMaxNs: number
  warpOvershootCount: number
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
  digestMsSum: number
  digestCount: number
  drawMsSum: number
  drawCount: number
  i2cStart: number
  bridgeStart: BridgeStats
}

const ZERO_BRIDGE: BridgeStats = {
  hotPolls: 0,
  hotGapMsSum: 0,
  hotPollsSlow: 0,
  requests: 0,
  kicks: 0,
  waiterWakeups: 0,
  waiterActive: false,
}

const empty = (): Counters => ({
  guestFrames: 0,
  uploads: 0,
  workerChecks: 0,
  workerMsSum: 0,
  digestMsSum: 0,
  digestCount: 0,
  drawMsSum: 0,
  drawCount: 0,
  i2cStart: 0,
  bridgeStart: ZERO_BRIDGE,
})

let enabled = false
let lastDigest = 0
let hasDigest = false
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
  digestMs: 0,
  drawMs: 0,
  i2cHz: 0,
  bridgePollMs: 0,
  bridgePollSlowPct: 0,
  bridgeHz: 0,
  bridgeWakeHz: 0,
  bridgeWaiterActive: false,
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
  if (sequence !== null) {
    if (hasFrameSequence && sequence === lastFrameSequence) return
    lastFrameSequence = sequence
    hasFrameSequence = true
    windowCounters.guestFrames += 1
    return
  }
  const frame = getFrame()
  if (!frame || frame.byteLength < 4) return
  if (snap.pointer % 4 !== 0 || frame.byteLength % 4 !== 0) return
  // Sparse FNV over every 4th pixel; coarser strides miss thin chart strokes.
  const words = new Uint32Array(frame.buffer, frame.byteOffset, frame.byteLength / 4)
  let hash = 0x811c9dc5
  for (let i = 0; i < words.length; i += 4) hash = Math.imul(hash ^ words[i], 0x01000193)
  if (hasDigest && hash === lastDigest) return
  lastDigest = hash
  hasDigest = true
  windowCounters.guestFrames += 1
}

export function recordWorkerFrame(stats: {
  uploaded: boolean
  digestMs?: number
  drawMs?: number
  checkMs?: number
}) {
  if (!enabled) return
  windowCounters.workerChecks += 1
  if (stats.checkMs !== undefined) windowCounters.workerMsSum += stats.checkMs
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
  const bridgeNow = bridgeStats()
  const hotPolls = Math.max(0, bridgeNow.hotPolls - c.bridgeStart.hotPolls)
  const bridgePollMs = hotPolls
    ? Math.max(0, bridgeNow.hotGapMsSum - c.bridgeStart.hotGapMsSum) / hotPolls
    : 0
  const bridgePollSlowPct = hotPolls
    ? (Math.max(0, bridgeNow.hotPollsSlow - c.bridgeStart.hotPollsSlow) / hotPolls) * 100
    : 0
  const notes: string[] = []
  const guestFps = c.guestFrames / elapsed
  const uploadFps = c.uploads / elapsed
  if (guestFps < 8) notes.push('guest_fps_low')
  if (uploadFps + 0.5 < guestFps) notes.push('uploads_behind_guest')
  if (i2cDelta / elapsed > 40) notes.push('i2c_hot')
  if (c.digestCount && c.digestMsSum / c.digestCount > 0.5) notes.push('digest_expensive')
  // The hot loop asks for 1 ms; near 4 ms means timer nesting clamp.
  if (hotPolls > 20 && bridgePollMs > 2) notes.push('bridge_poll_clamped')
  if (i2cDelta / elapsed > 40 && !bridgeNow.waiterActive) {
    notes.push('bridge_waiter_inactive')
  }
  const wake = wakeLatencyStats()
  const warp = warpOvershootStats()
  const notifySource = notifySourceStats()

  lastSnapshot = {
    wallMs: now,
    guestFps,
    uploadFps,
    workerFps: c.workerChecks / elapsed,
    workerMs: c.workerChecks ? c.workerMsSum / c.workerChecks : 0,
    digestMs: c.digestCount ? c.digestMsSum / c.digestCount : 0,
    drawMs: c.drawCount ? c.drawMsSum / c.drawCount : 0,
    i2cHz: i2cDelta / elapsed,
    bridgePollMs,
    bridgePollSlowPct,
    bridgeHz: Math.max(0, bridgeNow.requests - c.bridgeStart.requests) / elapsed,
    bridgeWakeHz:
      Math.max(0, bridgeNow.waiterWakeups - c.bridgeStart.waiterWakeups) / elapsed,
    bridgeWaiterActive: bridgeNow.waiterActive,
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
  hasDigest = false
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

export function installProfile() {
  if (typeof window === 'undefined') return
  window.__zephyrProfile = profile
  if (new URLSearchParams(location.search).has('profile')) profile.enable()
}
