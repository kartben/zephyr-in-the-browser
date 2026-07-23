/**
 * Browser end of the Ethernet bridge added by
 * tools/qemu-patches/0008-net-add-browser-netdev-backend.patch (and its JIT
 * twin): a QEMU `browser` netdev exposes two SPSC frame rings in the shared
 * wasm heap, and this module is the other side of the wire.
 *
 * Every frame the guest transmits is drained here and fed to the TypeScript
 * network stack (src/net/), which implements the entire LAN — DHCP, DNS,
 * SNTP, ICMP, TCP peers, an HTTP proxy riding fetch(). Replies are written
 * back into the RX ring. Because all traffic passes through this file, the
 * counters, throughput history, packet capture and .pcap export come free.
 *
 * Polling is adaptive: 100 ms at idle (one shared-memory index read), 10 ms
 * while frames flowed within the last 3 s, plus one opportunistic drain just
 * after each injected frame so request/response handshakes complete in a
 * couple of ticks rather than a couple of poll periods.
 */

import { ipToString, macToString } from '@/net/bytes'
import { summarize } from '@/net/decode'
import { writePcap } from '@/net/pcap'
import { ringDrain, ringWrite } from '@/net/ringCodec'
import { NetStack, type DhcpState } from '@/net/stack'
import { installEchoHost } from '@/net/services/echoHost'
import { installHttpProxy } from '@/net/services/httpProxy'
import { installZperf } from '@/net/services/zperf'
import {
  echoToGuest as echoService,
  httpGetFromHost as httpGetService,
  type HttpGetResult,
} from '@/net/services/guestClient'

interface NetExports {
  _qemu_browser_net_ready?: () => number
  _qemu_browser_net_ring_size?: () => number
  _qemu_browser_net_tx_ring?: () => number
  _qemu_browser_net_tx_write_index?: () => number
  _qemu_browser_net_tx_read_index?: () => number
  _qemu_browser_net_tx_set_read_index?: (v: number) => void
  _qemu_browser_net_rx_ring?: () => number
  _qemu_browser_net_rx_write_index?: () => number
  _qemu_browser_net_rx_read_index?: () => number
  _qemu_browser_net_rx_set_write_index?: (v: number) => void
  _qemu_browser_net_set_link?: (up: number) => void
  /** Refreshed by Emscripten on memory growth — always read via the module. */
  HEAPU8?: Uint8Array
}

export interface CaptureEntry {
  id: number
  /** Epoch ms. */
  ts: number
  /** Guest perspective: tx = guest transmitted, rx = guest received. */
  dir: 'tx' | 'rx'
  len: number
  data: Uint8Array
  proto: string
  summary: string
}

export interface NetSnapshot {
  available: boolean
  linkUp: boolean
  guestMac: string | null
  guestIp: string | null
  dhcpState: DhcpState
  gatewayIp: string
  dnsIp: string
  /** Guest-perspective rates, EMA-smoothed bits/s. */
  rxBps: number
  txBps: number
  rxHistory: readonly number[]
  txHistory: readonly number[]
  rxPackets: number
  txPackets: number
  rxBytes: number
  txBytes: number
  captureCount: number
  captureVersion: number
  capturePaused: boolean
  impairments: { delayMs: number; lossPct: number }
}

const HISTORY = 48
const STATS_MS = 500
const EMA_ALPHA = 0.35
const POLL_IDLE_MS = 100
const POLL_HOT_MS = 10
const HOT_WINDOW_MS = 3000
const CAPTURE_CAP = 500

const EMPTY: NetSnapshot = {
  available: false,
  linkUp: true,
  guestMac: null,
  guestIp: null,
  dhcpState: 'waiting',
  gatewayIp: '192.0.2.2',
  dnsIp: '192.0.2.3',
  rxBps: 0,
  txBps: 0,
  rxHistory: [],
  txHistory: [],
  rxPackets: 0,
  txPackets: 0,
  rxBytes: 0,
  txBytes: 0,
  captureCount: 0,
  captureVersion: 0,
  capturePaused: false,
  impairments: { delayMs: 0, lossPct: 0 },
}

let exports: NetExports | null = null
let stack: NetStack | null = null
let snapshot: NetSnapshot = EMPTY
let generation = 0

let ringSize = 0
let txBase = 0
let rxBase = 0
let txRd = 0

let linkUp = true
let impairments = { delayMs: 0, lossPct: 0 }
let captures: CaptureEntry[] = []
let captureVersion = 0
let capturePaused = false
let captureId = 1
let pendingRx: Uint8Array[] = []

let rxBytes = 0
let txBytes = 0
let rxPackets = 0
let txPackets = 0
let lastRxBytes = 0
let lastTxBytes = 0
let lastStatsAt = 0
let rxEma = 0
let txEma = 0
let rxHistory: number[] = []
let txHistory: number[] = []

let poll: ReturnType<typeof setInterval> | undefined
let pollFast = false
let statsTimer: ReturnType<typeof setInterval> | undefined
let notifyTimer: ReturnType<typeof setTimeout> | undefined
let lastActivity = 0

const listeners = new Set<() => void>()

function hasExports(mod: NetExports): boolean {
  return (
    typeof mod._qemu_browser_net_ready === 'function' &&
    typeof mod._qemu_browser_net_ring_size === 'function' &&
    typeof mod._qemu_browser_net_tx_ring === 'function' &&
    typeof mod._qemu_browser_net_rx_ring === 'function' &&
    mod.HEAPU8 !== undefined
  )
}

export function attach(mod: unknown) {
  detach()
  const candidate = mod as NetExports
  // No _ready() gate: attach runs while QEMU's main() is still parsing argv
  // on its pthread, so the netdev may not exist yet. The ring buffers are
  // static arrays whose addresses are valid from load, and the indices sit
  // at zero until the backend comes up — polling them early is harmless.
  if (!hasExports(candidate)) return
  exports = candidate
  generation += 1

  ringSize = exports._qemu_browser_net_ring_size!()
  txBase = exports._qemu_browser_net_tx_ring!()
  rxBase = exports._qemu_browser_net_rx_ring!()
  txRd = exports._qemu_browser_net_tx_read_index!()
  linkUp = true
  exports._qemu_browser_net_set_link?.(1)

  stack = new NetStack({
    sendFrame: (frame) => deliverToGuest(frame),
    now: () => Date.now(),
    random: Math.random,
    fetchImpl: typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null,
    onEvent: () => rebuild(),
  })
  installHttpProxy(stack)
  installEchoHost(stack)
  installZperf(stack)

  lastStatsAt = performance.now()
  statsTimer = setInterval(sampleStats, STATS_MS)
  startPoll(false)
  rebuild()
}

export function detach() {
  generation += 1
  if (poll !== undefined) clearInterval(poll)
  if (statsTimer !== undefined) clearInterval(statsTimer)
  if (notifyTimer !== undefined) clearTimeout(notifyTimer)
  poll = statsTimer = notifyTimer = undefined
  stack?.dispose()
  stack = null
  exports = null
  captures = []
  pendingRx = []
  captureVersion = 0
  capturePaused = false
  rxBytes = txBytes = rxPackets = txPackets = 0
  lastRxBytes = lastTxBytes = 0
  rxEma = txEma = 0
  rxHistory = []
  txHistory = []
  impairments = { delayMs: 0, lossPct: 0 }
  linkUp = true
  if (snapshot !== EMPTY) {
    snapshot = EMPTY
    notify()
  }
}

export function available(): boolean {
  return exports !== null
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): NetSnapshot {
  return snapshot
}

export function getCaptures(): readonly CaptureEntry[] {
  return captures
}

/* ------------------------------------------------------------- controls */

export function setLink(up: boolean) {
  if (!exports) return
  linkUp = up
  exports._qemu_browser_net_set_link?.(up ? 1 : 0)
  rebuild()
}

export function setImpairments(next: { delayMs?: number; lossPct?: number }) {
  impairments = {
    delayMs: Math.max(0, Math.min(2000, next.delayMs ?? impairments.delayMs)),
    lossPct: Math.max(0, Math.min(100, next.lossPct ?? impairments.lossPct)),
  }
  rebuild()
}

export function pauseCapture(paused: boolean) {
  capturePaused = paused
  rebuild()
}

export function clearCapture() {
  captures = []
  captureVersion += 1
  rebuild()
}

export function buildPcapBlob(): Blob {
  const pcap = writePcap(captures.map((c) => ({ ts: c.ts, data: c.data })))
  // Copy onto a plain ArrayBuffer: BlobPart rejects SAB-backed views.
  return new Blob([new Uint8Array(pcap).buffer as ArrayBuffer], {
    type: 'application/vnd.tcpdump.pcap',
  })
}

/** Panel tool: HTTP GET against a server running in the guest. */
export function httpGetFromHost(url: string): Promise<HttpGetResult> {
  if (!stack) return Promise.reject(new Error('Network bridge not attached'))
  return httpGetService(stack, url)
}

/** Panel tool: TCP/UDP echo against the guest's echo server. */
export function echoToGuest(payload: string, proto: 'tcp' | 'udp'): Promise<string> {
  if (!stack) return Promise.reject(new Error('Network bridge not attached'))
  return echoService(stack, payload, proto)
}

/* ------------------------------------------------------------ data path */

/** Guest → page. */
function drainTx() {
  const mod = exports
  if (!mod) return
  const heap = mod.HEAPU8!
  const wr = mod._qemu_browser_net_tx_write_index!()
  if (wr === txRd) return
  txRd = ringDrain(heap, txBase, ringSize, txRd, wr, (frame) => {
    txPackets += 1
    txBytes += frame.length
    capture('tx', frame)
    markActive()
    if (!impair()) stack?.onGuestFrame(frame)
  })
  mod._qemu_browser_net_tx_set_read_index!(txRd)
}

/** Page → guest, via impairments and the RX ring. */
function deliverToGuest(frame: Uint8Array) {
  if (!exports) return
  if (impair()) return
  if (impairments.delayMs > 0) {
    const gen = generation
    setTimeout(() => {
      if (gen === generation) writeRx(frame)
    }, impairments.delayMs)
  } else {
    writeRx(frame)
  }
}

function writeRx(frame: Uint8Array) {
  const mod = exports
  if (!mod) return
  if (pendingRx.length > 0) {
    pendingRx.push(frame)
    flushPendingRx()
    return
  }
  if (!tryWriteRx(frame)) pendingRx.push(frame)
  else afterRxWrite(frame)
}

function tryWriteRx(frame: Uint8Array): boolean {
  const mod = exports!
  const heap = mod.HEAPU8!
  const wr = mod._qemu_browser_net_rx_write_index!()
  const rd = mod._qemu_browser_net_rx_read_index!()
  const next = ringWrite(heap, rxBase, ringSize, wr, rd, frame)
  if (next === null) return false
  mod._qemu_browser_net_rx_set_write_index!(next)
  return true
}

function flushPendingRx() {
  while (pendingRx.length > 0) {
    const frame = pendingRx[0]
    if (!tryWriteRx(frame)) return
    pendingRx.shift()
    afterRxWrite(frame)
  }
}

function afterRxWrite(frame: Uint8Array) {
  rxPackets += 1
  rxBytes += frame.length
  capture('rx', frame)
  markActive()
  // One opportunistic drain shortly after injecting: the guest's reply to a
  // request often lands within a few milliseconds of virtual time.
  const gen = generation
  setTimeout(() => {
    if (gen === generation) drainTx()
  }, 4)
}

/** True when the wire eats this frame. */
function impair(): boolean {
  return impairments.lossPct > 0 && Math.random() * 100 < impairments.lossPct
}

function capture(dir: 'tx' | 'rx', frame: Uint8Array) {
  if (capturePaused) return
  const { proto, text } = summarize(frame)
  captures.push({
    id: captureId++,
    ts: Date.now(),
    dir,
    len: frame.length,
    data: frame,
    proto,
    summary: text,
  })
  if (captures.length > CAPTURE_CAP) captures = captures.slice(-CAPTURE_CAP)
  captureVersion += 1
  notifySoon()
}

/* ---------------------------------------------------------------- pacing */

function markActive() {
  lastActivity = performance.now()
  if (!pollFast) startPoll(true)
}

function startPoll(fast: boolean) {
  if (poll !== undefined) clearInterval(poll)
  pollFast = fast
  poll = setInterval(pollTick, fast ? POLL_HOT_MS : POLL_IDLE_MS)
}

function pollTick() {
  drainTx()
  flushPendingRx()
  stack?.tick()
  if (pollFast && performance.now() - lastActivity > HOT_WINDOW_MS) startPoll(false)
}

function sampleStats() {
  const now = performance.now()
  const dt = (now - lastStatsAt) / 1000
  lastStatsAt = now
  if (dt <= 0) return
  const rxInst = ((rxBytes - lastRxBytes) * 8) / dt
  const txInst = ((txBytes - lastTxBytes) * 8) / dt
  lastRxBytes = rxBytes
  lastTxBytes = txBytes
  rxEma = rxEma === 0 ? rxInst : rxEma + EMA_ALPHA * (rxInst - rxEma)
  txEma = txEma === 0 ? txInst : txEma + EMA_ALPHA * (txInst - txEma)
  rxHistory = [...rxHistory, rxInst].slice(-HISTORY)
  txHistory = [...txHistory, txInst].slice(-HISTORY)
  rebuild()
}

/* ------------------------------------------------------------- snapshot */

function rebuild() {
  if (!exports || !stack) return
  snapshot = {
    available: true,
    linkUp,
    guestMac: stack.guestMac ? macToString(stack.guestMac) : null,
    guestIp: stack.guestIp !== null ? ipToString(stack.guestIp) : null,
    dhcpState: stack.dhcpState,
    gatewayIp: ipToString(stack.gwIp),
    dnsIp: ipToString(stack.dnsIp),
    rxBps: rxEma,
    txBps: txEma,
    rxHistory,
    txHistory,
    rxPackets,
    txPackets,
    rxBytes,
    txBytes,
    captureCount: captures.length,
    captureVersion,
    capturePaused,
    impairments,
  }
  notify()
}

function notify() {
  for (const fn of listeners) fn()
}

/** Coalesce capture-driven notifies so a zperf flood re-renders ≤10×/s. */
function notifySoon() {
  if (notifyTimer !== undefined) return
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined
    rebuild()
  }, 100)
}
