/**
 * Browser client for the uber bridge (CTF + optional NET + GDB over one WS).
 *
 * Configured once via bridgeStore (Settings). Trace and Network both use this
 * singleton — no second URL to paste.
 */

import * as hostTrace from '@/hostTrace'
import {
  isValidBridgeUrl,
  resolveBridgeConfig,
  subscribe as subscribeSettings,
} from '@/lib/bridgeStore'
import { getMode, subscribe as subscribeMode } from '@/lib/modeStore'
import {
  CH_CTF,
  CH_CTRL,
  CH_NET,
  decodeCtrl,
  decodeFrame,
  encodeCtrl,
  encodeFrame,
  type BridgeFeatures,
  type GdbStatus,
  type ProbePortInfo,
  type SerialStatus,
} from '@/probe/protocol'
import { trimEthernetPadding } from '@/net/uplink'

export type BridgePhase = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

export interface BridgeSnapshot {
  phase: BridgePhase
  detail: string
  attempts: number
  ports: ProbePortInfo[]
  serial: SerialStatus | null
  gdb: GdbStatus | null
  features: BridgeFeatures | null
  ctfBytes: number
  netBytes: number
  url: string
  enabled: boolean
}

const EMPTY_FEATURES: BridgeFeatures = { ctf: true, gdb: true, net: false }

const EMPTY: BridgeSnapshot = {
  phase: 'idle',
  detail: '',
  attempts: 0,
  ports: [],
  serial: null,
  gdb: null,
  features: null,
  ctfBytes: 0,
  netBytes: 0,
  url: '',
  enabled: false,
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const
const STABLE_MS = 5000
const SEND_BUFFER_CAP = 1 << 20

let snapshot: BridgeSnapshot = { ...EMPTY }
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let wantConnected = false
let attempt = 0
let connectedAt = 0
let externalActive = false
const listeners = new Set<() => void>()

/** Test hook: inject a WebSocket stand-in (same idea as net/uplink). */
let wsFactoryForTests: ((url: string) => WebSocket) | null = null

export function setWsFactoryForTests(factory: ((url: string) => WebSocket) | null): void {
  wsFactoryForTests = factory
}

/** hostNet registers to receive Ethernet frames from the bridge. */
type NetHandler = {
  deliverFrame: (frame: Uint8Array) => void
  onPhaseChange: () => void
}
let netHandler: NetHandler | null = null
let droppedTx = 0

function notify() {
  for (const fn of listeners) fn()
}

function publish(partial: Partial<BridgeSnapshot>) {
  snapshot = { ...snapshot, ...partial }
  notify()
}

function closeSocket() {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
  if (ws) {
    const sock = ws
    ws = null
    try {
      sock.onopen = null
      sock.onclose = null
      sock.onerror = null
      sock.onmessage = null
      sock.close()
    } catch {
      /* */
    }
  }
}

function endExternal() {
  if (!externalActive) return
  externalActive = false
  hostTrace.endExternal()
}

/**
 * The bridge owns the Trace decoder only in Live board mode. A Simulator
 * session may keep the bridge connected for Bridge network, and guest CTF
 * polling must keep running there. Mode changes navigate in practice; the
 * ownership still follows the store so this module is correct on its own.
 */
function syncTraceOwnership() {
  const shouldOwn = getMode() === 'live' && snapshot.phase === 'connected'
  if (shouldOwn && !externalActive) {
    hostTrace.beginExternal('bridge')
    externalActive = true
  } else if (!shouldOwn) {
    endExternal()
  }
}

function scheduleReconnect() {
  if (!wantConnected) return
  if (reconnectTimer !== undefined) return
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
  attempt += 1
  publish({ phase: 'connecting', detail: `retry in ${delay}ms`, attempts: attempt })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    openSocket()
  }, delay)
}

function openSocket() {
  const cfg = resolveBridgeConfig()
  if (!cfg.enabled || !isValidBridgeUrl(cfg.url)) {
    wantConnected = false
    publish({
      phase: 'idle',
      detail: cfg.enabled ? 'set a bridge URL in Settings' : '',
      url: cfg.url,
      enabled: cfg.enabled,
    })
    netHandler?.onPhaseChange()
    return
  }

  closeSocket()
  wantConnected = true
  publish({
    phase: 'connecting',
    detail: '',
    url: cfg.url,
    enabled: true,
    attempts: attempt,
  })
  netHandler?.onPhaseChange()

  let sock: WebSocket
  try {
    sock = wsFactoryForTests ? wsFactoryForTests(cfg.url) : new WebSocket(cfg.url)
  } catch (err) {
    publish({
      phase: 'error',
      detail: err instanceof Error ? err.message : String(err),
    })
    netHandler?.onPhaseChange()
    scheduleReconnect()
    return
  }
  sock.binaryType = 'arraybuffer'
  ws = sock

  sock.onopen = () => {
    if (ws !== sock) return
    connectedAt = performance.now()
    attempt = 0
    publish({ phase: 'connected', detail: '', attempts: 0 })
    syncTraceOwnership()
    netHandler?.onPhaseChange()
  }

  sock.onmessage = (ev) => {
    if (ws !== sock) return
    if (typeof ev.data === 'string') {
      try {
        handleCtrl(JSON.parse(ev.data) as Record<string, unknown>)
      } catch {
        /* ignore */
      }
      return
    }
    const frame = decodeFrame(ev.data as ArrayBuffer)
    if (!frame) return
    if (frame.channel === CH_CTF) {
      // Feed only while the bridge owns the decoder (Live board mode) —
      // feedExternal would otherwise seize it from a running Simulator app.
      if (externalActive) hostTrace.feedExternal(frame.payload)
      publish({ ctfBytes: snapshot.ctfBytes + frame.payload.length })
      return
    }
    if (frame.channel === CH_NET) {
      publish({ netBytes: snapshot.netBytes + frame.payload.length })
      netHandler?.deliverFrame(frame.payload)
      return
    }
    if (frame.channel === CH_CTRL) {
      try {
        handleCtrl(decodeCtrl(frame.payload) as Record<string, unknown>)
      } catch {
        /* ignore */
      }
    }
  }

  sock.onerror = () => {
    /* close handler */
  }

  sock.onclose = (ev) => {
    if (ws !== sock) return
    ws = null
    endExternal()
    const detail =
      ev.code === 4001
        ? 'unauthorized (bad token)'
        : ev.code === 4002
          ? 'bridge full'
          : ev.reason || `closed (${ev.code})`
    if (!wantConnected) {
      publish({ phase: 'closed', detail })
      netHandler?.onPhaseChange()
      return
    }
    if (performance.now() - connectedAt > STABLE_MS) attempt = 0
    publish({ phase: 'error', detail, ports: [], serial: null })
    netHandler?.onPhaseChange()
    scheduleReconnect()
  }
}

function handleCtrl(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'hello':
      publish({
        ports: Array.isArray(msg.ports) ? (msg.ports as ProbePortInfo[]) : [],
        serial: (msg.serial as SerialStatus) ?? null,
        gdb: (msg.gdb as GdbStatus) ?? null,
        features: (msg.features as BridgeFeatures) ?? EMPTY_FEATURES,
      })
      return
    case 'ports':
      publish({ ports: Array.isArray(msg.ports) ? (msg.ports as ProbePortInfo[]) : [] })
      return
    case 'serial-status':
      publish({
        serial: {
          path: (msg.path as string) ?? null,
          baudRate: Number(msg.baudRate ?? 115200),
          phase: String(msg.phase ?? 'idle'),
          detail: String(msg.detail ?? ''),
        },
      })
      return
    case 'gdb-status':
      publish({
        gdb: {
          host: String(msg.host ?? '127.0.0.1'),
          port: Number(msg.port ?? 3333),
          phase: String(msg.phase ?? 'idle'),
          detail: String(msg.detail ?? ''),
        },
      })
      return
    case 'net-status':
      // Reserved for per-client net health; phase stays on the WS.
      return
    default:
      return
  }
}

function sendRaw(buf: Uint8Array) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(new Uint8Array(buf))
  return true
}

function sendCtrl(obj: unknown) {
  sendRaw(encodeCtrl(obj))
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): BridgeSnapshot {
  return snapshot
}

export function connect(): void {
  attempt = 0
  wantConnected = true
  openSocket()
}

export function disconnect(): void {
  wantConnected = false
  closeSocket()
  endExternal()
  publish({ phase: 'closed', detail: '', ports: [], serial: null, gdb: null })
  netHandler?.onPhaseChange()
}

export function selectSerial(path: string, baudRate = 115200): void {
  sendCtrl({ type: 'select-serial', path, baudRate })
}

export function stopSerial(): void {
  sendCtrl({ type: 'stop-serial' })
}

export function refreshPorts(): void {
  sendCtrl({ type: 'list-ports' })
}

/** Register (or clear) the Network panel's Ethernet sink. */
export function setNetHandler(handler: NetHandler | null): void {
  netHandler = handler
  handler?.onPhaseChange()
}

export function getDroppedTx(): number {
  return droppedTx
}

export function resetDroppedTx(): void {
  droppedTx = 0
}

/**
 * Guest → bridge Ethernet. Same contract as UplinkSink.onGuestFrame.
 * Returns false when the frame was dropped.
 */
export function sendNetFrame(frame: Uint8Array): boolean {
  frame = trimEthernetPadding(frame)
  if (snapshot.phase !== 'connected' || !ws || ws.readyState !== WebSocket.OPEN) {
    droppedTx += 1
    return false
  }
  if (ws.bufferedAmount > SEND_BUFFER_CAP) {
    droppedTx += 1
    return false
  }
  return sendRaw(encodeFrame(CH_NET, frame))
}

export function isNetLive(): boolean {
  return (
    snapshot.phase === 'connected' &&
    (snapshot.features?.net ?? false) &&
    !!ws &&
    ws.readyState === WebSocket.OPEN
  )
}

export function syncFromSettings(): void {
  const cfg = resolveBridgeConfig()
  publish({ enabled: cfg.enabled, url: cfg.url })
  if (cfg.enabled && isValidBridgeUrl(cfg.url)) {
    if (
      (snapshot.phase === 'connected' || snapshot.phase === 'connecting') &&
      snapshot.url === cfg.url
    ) {
      return
    }
    connect()
  } else {
    disconnect()
    publish({ phase: 'idle', enabled: cfg.enabled, url: cfg.url })
  }
}

let started = false

export function startBridgeClient(): void {
  if (started) return
  started = true
  subscribeSettings(() => syncFromSettings())
  subscribeMode(() => syncTraceOwnership())
  syncFromSettings()
}

export function _resetForTests(): void {
  disconnect()
  snapshot = { ...EMPTY }
  attempt = 0
  started = false
  droppedTx = 0
  netHandler = null
  notify()
}

// Back-compat aliases used by ProbeSection during the rename.
export const startProbeClient = startBridgeClient
export type ProbePhase = BridgePhase
export type ProbeSnapshot = BridgeSnapshot
