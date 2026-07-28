/**
 * Browser end of the Bluetooth HCI (H:4) chardev bridge.
 *
 * Bytes from the guest (Zephyr host) are framed and handed to the in-page
 * Bumble controller; controller→host HCI packets are fed back into the
 * qemu_browser_hci_* rings. Peers live on the same LocalLink — the page is
 * the air. See docs/bluetooth-bumble-feasibility.md and
 * docs/bluetooth-peer-ui-spec.md (select-one inspector).
 */

import { bindChardev, chardevAvailable, drainBytes, feedBytes, type ChardevExports } from '@/debug/browserChardev'
import { H4Framer } from '@/bt/h4'
import { ensureController, type BtControllerHandle } from '@/bt/bumbleController'
import {
  defaultPeerParams,
  peerDetail,
  peerType,
  type BtPeerParams,
  type BtPeerParamValue,
} from '@/bt/peers'

export type BtPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface BtPeerSnapshot {
  id: string
  typeId: string
  name: string
  detail: string
  /** Zephyr / in-page controller row — not removable. */
  local?: boolean
  /** Live inspector knobs (remote peers). */
  params?: BtPeerParams
}

export interface BtSnapshot {
  available: boolean
  phase: BtPhase
  detail: string
  /** HCI packets seen host→controller / controller→host this session. */
  rxPackets: number
  txPackets: number
  controllerName: string
  peers: BtPeerSnapshot[]
  /** Selected remote peer for the inspector; null = none. */
  selectedPeerId: string | null
}

const POLL_MS = 20
const listeners = new Set<() => void>()

let ch: ChardevExports | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let framer = new H4Framer()
let controller: BtControllerHandle | null = null
let starting: Promise<void> | null = null
let mockMode = false
let mockSeq = 0
let mockPeers: BtPeerSnapshot[] = []
let selectedPeerId: string | null = null

let snapshot: BtSnapshot = {
  available: false,
  phase: 'idle',
  detail: '',
  rxPackets: 0,
  txPackets: 0,
  controllerName: '',
  peers: [],
  selectedPeerId: null,
}

function localPeer(name: string): BtPeerSnapshot {
  return {
    id: 'local',
    typeId: 'controller',
    name,
    detail: 'Virtual controller · HCI to Zephyr',
    local: true,
  }
}

function withDetail(peer: BtPeerSnapshot): BtPeerSnapshot {
  if (peer.local) return peer
  const type = peerType(peer.typeId)
  return {
    ...peer,
    detail: peerDetail(peer.typeId, peer.params, type?.summary ?? peer.detail),
  }
}

function rosterFromController(): BtPeerSnapshot[] {
  if (!controller) return []
  return [
    localPeer(controller.name),
    ...controller.listPeers().map((p) => {
      const fromPy = controller?.peerParams(p.id) ?? null
      const overlay = mockPeers.find((m) => m.id === p.id)?.params
      const params = fromPy ?? overlay ?? defaultPeerParams(p.typeId, p.name)
      return withDetail({
        id: p.id,
        typeId: p.typeId,
        name: p.name,
        detail: p.detail,
        params,
      })
    }),
  ]
}

function setSnapshot(patch: Partial<BtSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  notify()
}

function notify() {
  for (const fn of listeners) fn()
}

function refreshPeers() {
  const peers = mockMode
    ? snapshot.controllerName
      ? [localPeer(snapshot.controllerName), ...mockPeers.map(withDetail)]
      : mockPeers.map(withDetail)
    : controller
      ? rosterFromController()
      : []

  if (selectedPeerId && !peers.some((p) => p.id === selectedPeerId && !p.local)) {
    selectedPeerId = null
  }
  setSnapshot({ peers, selectedPeerId })
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): BtSnapshot {
  return snapshot
}

export function available(): boolean {
  return snapshot.available
}

export { BT_PEER_TYPES, peerType, BODY_SENSOR_LOCATIONS } from '@/bt/peers'
export type { BtPeerParams, BtPeerParamValue } from '@/bt/peers'

/** Bind the hci0 chardev exports from an Emscripten Module. */
export function attach(mod: unknown) {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  ch = null
  framer.reset()

  const bound = bindChardev(mod as Record<string, unknown>, 'hci')
  if (!chardevAvailable(bound)) {
    controller?.close()
    controller = null
    starting = null
    setSnapshot({
      available: false,
      phase: 'idle',
      detail: 'emulator has no hci0 chardev (rebuild qemu-wasm with HCI patches)',
      rxPackets: 0,
      txPackets: 0,
      controllerName: '',
      peers: [],
      selectedPeerId: null,
    })
    return
  }
  ch = bound
  framer = new H4Framer()
  setSnapshot({
    available: true,
    phase: controller ? 'ready' : starting ? 'loading' : 'idle',
    detail:
      controller || starting
        ? snapshot.detail
        : 'HCI pipe ready — start the controller when a BT sample runs',
    rxPackets: 0,
    txPackets: 0,
    controllerName: controller?.name ?? '',
    peers: controller ? rosterFromController() : [],
    selectedPeerId,
  })
  pollTimer = setInterval(poll, POLL_MS)
  // The QEMU backend preloads Bumble for Bluetooth samples before main(). This
  // remains as the fallback for custom guests and older callers.
  void startController()
}

/**
 * Mock-backend demo: show a live Bluetooth dock row without qemu-wasm or
 * Pyodide. Used so the panel is screenshotable on a bare checkout.
 */
export function attachMockDemo() {
  detach()
  mockMode = true
  mockSeq = 0
  mockPeers = []
  selectedPeerId = null
  ch = {
    feed: () => 0,
    ring: () => 0,
    ringSize: () => 0,
    readIndex: () => 0,
    writeIndex: () => 0,
    setReadIndex: () => {},
  }
  setSnapshot({
    available: true,
    phase: 'ready',
    detail: 'Bumble virtual controller on LocalLink',
    rxPackets: 12,
    txPackets: 9,
    controllerName: 'zephyr-browser',
    peers: [localPeer('zephyr-browser')],
    selectedPeerId: null,
  })
}

export function detach() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  ch = null
  controller?.close()
  controller = null
  starting = null
  mockMode = false
  mockSeq = 0
  mockPeers = []
  selectedPeerId = null
  framer.reset()
  setSnapshot({
    available: false,
    phase: 'idle',
    detail: '',
    rxPackets: 0,
    txPackets: 0,
    controllerName: '',
    peers: [],
    selectedPeerId: null,
  })
}

export async function startController(): Promise<void> {
  if (mockMode) return
  if (controller || starting) return starting ?? Promise.resolve()
  setSnapshot({ phase: 'loading', detail: 'loading Pyodide + Bumble…' })
  starting = (async () => {
    try {
      const handle = await ensureController({
        onHostPacket: (packet) => {
          if (!ch) return
          if (!feedBytes(ch, packet)) {
            console.warn('[bt] HCI TX ring full; dropping controller→host packet')
            return
          }
          setSnapshot({ txPackets: snapshot.txPackets + 1 })
        },
        onPeersChanged: () => refreshPeers(),
      })
      controller = handle
      setSnapshot({
        phase: 'ready',
        detail: 'Bumble virtual controller on LocalLink',
        controllerName: handle.name,
        peers: rosterFromController(),
        selectedPeerId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSnapshot({ phase: 'error', detail: message, peers: [], selectedPeerId: null })
      console.error('[bt] controller start failed', err)
    } finally {
      starting = null
    }
  })()
  return starting
}

/** Select a remote peer for the inspector; local clears selection. */
export function selectPeer(id: string | null) {
  if (id === 'local') {
    selectedPeerId = null
    setSnapshot({ selectedPeerId: null })
    return
  }
  if (id && selectedPeerId === id) {
    // Second click deselects (spec open question — chosen for mockups).
    selectedPeerId = null
    setSnapshot({ selectedPeerId: null })
    return
  }
  if (id && !snapshot.peers.some((p) => p.id === id && !p.local)) return
  selectedPeerId = id
  setSnapshot({ selectedPeerId: id })
}

/** Add an in-page peer on the shared LocalLink (or mock roster). */
export async function addPeer(typeId: string): Promise<void> {
  const type = peerType(typeId)
  if (!type) throw new Error(`unknown Bluetooth peer type: ${typeId}`)

  if (mockMode) {
    mockSeq += 1
    const shortName =
      typeId === 'hrm'
        ? 'Heart rate'
        : typeId === 'advertiser'
          ? 'Advertiser'
          : typeId === 'speaker'
            ? 'Speaker'
            : 'Scanner'
    const name = `${shortName} ${mockSeq}`
    const params = defaultPeerParams(typeId, name)
    // Seed scanner / speaker so inspectors look alive in demos.
    if (typeId === 'scanner') params.advCount = 3
    if (typeId === 'speaker') {
      params.streamState = 'started'
      params.packets = 128
      params.bytes = 4096
    }
    const peer: BtPeerSnapshot = {
      id: `${typeId}-${mockSeq}`,
      typeId,
      name,
      detail: type.summary,
      params,
    }
    mockPeers = [...mockPeers, withDetail(peer)]
    selectedPeerId = peer.id
    refreshPeers()
    return
  }

  if (!controller) await startController()
  if (!controller) throw new Error('Bluetooth controller not ready')
  const info = await controller.addPeer(typeId)
  // Keep a params overlay so the inspector works before Bumble setParam lands.
  mockPeers = [
    ...mockPeers.filter((p) => p.id !== info.id),
    withDetail({
      id: info.id,
      typeId: info.typeId,
      name: info.name,
      detail: info.detail,
      params: defaultPeerParams(info.typeId, info.name),
    }),
  ]
  selectedPeerId = info.id
  refreshPeers()
}

export async function removePeer(id: string): Promise<void> {
  if (id === 'local') return

  if (mockMode) {
    mockPeers = mockPeers.filter((p) => p.id !== id)
    if (selectedPeerId === id) selectedPeerId = null
    refreshPeers()
    return
  }

  if (!controller) return
  await controller.removePeer(id)
  mockPeers = mockPeers.filter((p) => p.id !== id)
  if (selectedPeerId === id) selectedPeerId = null
  refreshPeers()
}

/** Update an inspector param and apply supported values to the live peer. */
export async function setPeerParam(
  id: string,
  key: string,
  value: BtPeerParamValue,
): Promise<void> {
  const apply = (peer: BtPeerSnapshot): BtPeerSnapshot => {
    if (peer.id !== id || peer.local) return peer
    const params = { ...(peer.params ?? {}), [key]: value }
    return withDetail({ ...peer, params })
  }

  if (mockMode) {
    mockPeers = mockPeers.map(apply)
    if (key === 'muted') {
      const { setPeerMuted } = await import('@/bt/speakerAudio')
      setPeerMuted(id, Boolean(value))
    }
    refreshPeers()
    return
  }

  mockPeers = mockPeers.map(apply)
  if (mockPeers.every((p) => p.id !== id)) {
    const existing = snapshot.peers.find((p) => p.id === id)
    if (existing && !existing.local) {
      mockPeers = [...mockPeers, apply(existing)]
    }
  }
  if (key === 'muted') {
    const { setPeerMuted } = await import('@/bt/speakerAudio')
    setPeerMuted(id, Boolean(value))
  }
  if (controller) {
    try {
      await controller.setPeerParam(id, key, value)
    } catch (err) {
      console.warn('[bt] setPeerParam failed', err)
    }
  }
  refreshPeers()
}

function poll() {
  if (!ch || mockMode) return
  const bytes = drainBytes(ch)
  if (bytes.length === 0) return
  const packets = framer.push(bytes)
  for (const packet of packets) {
    setSnapshot({ rxPackets: snapshot.rxPackets + 1 })
    if (controller) {
      controller.onHostPacket(packet)
    }
  }
}
