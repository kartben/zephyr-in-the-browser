/**
 * Browser end of the Bluetooth HCI (H:4) chardev bridge.
 *
 * Bytes from the guest (Zephyr host) are framed and handed to the in-page
 * Bumble controller; controller→host HCI packets are fed back into the
 * qemu_browser_hci_* rings. See docs/bluetooth-bumble-feasibility.md.
 */

import { bindChardev, chardevAvailable, drainBytes, feedBytes, type ChardevExports } from '@/debug/browserChardev'
import { H4Framer } from '@/bt/h4'
import { ensureController, type BtControllerHandle } from '@/bt/bumbleController'

export type BtPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface BtSnapshot {
  available: boolean
  phase: BtPhase
  detail: string
  /** HCI packets seen host→controller / controller→host this session. */
  rxPackets: number
  txPackets: number
  controllerName: string
}

const POLL_MS = 20
const listeners = new Set<() => void>()

let ch: ChardevExports | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let framer = new H4Framer()
let controller: BtControllerHandle | null = null
let starting: Promise<void> | null = null

let snapshot: BtSnapshot = {
  available: false,
  phase: 'idle',
  detail: '',
  rxPackets: 0,
  txPackets: 0,
  controllerName: '',
}

function setSnapshot(patch: Partial<BtSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  notify()
}

function notify() {
  for (const fn of listeners) fn()
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

/** Bind the hci0 chardev exports from an Emscripten Module. */
export function attach(mod: unknown) {
  detach()
  const bound = bindChardev(mod as Record<string, unknown>, 'hci')
  if (!chardevAvailable(bound)) {
    setSnapshot({
      available: false,
      phase: 'idle',
      detail: 'emulator has no hci0 chardev (rebuild qemu-wasm with HCI patches)',
      rxPackets: 0,
      txPackets: 0,
      controllerName: '',
    })
    return
  }
  ch = bound
  framer = new H4Framer()
  setSnapshot({
    available: true,
    phase: 'idle',
    detail: 'HCI pipe ready — start the controller when a BT sample runs',
    rxPackets: 0,
    txPackets: 0,
    controllerName: '',
  })
  pollTimer = setInterval(poll, POLL_MS)
  // Eagerly bring up Bumble so the first HCI Reset from the guest is answered.
  void startController()
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
  framer.reset()
  setSnapshot({
    available: false,
    phase: 'idle',
    detail: '',
    rxPackets: 0,
    txPackets: 0,
    controllerName: '',
  })
}

export async function startController(): Promise<void> {
  if (controller || starting) return starting ?? Promise.resolve()
  if (!ch) {
    setSnapshot({ phase: 'error', detail: 'no HCI chardev' })
    return
  }
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
      })
      controller = handle
      setSnapshot({
        phase: 'ready',
        detail: 'Bumble virtual controller on LocalLink',
        controllerName: handle.name,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSnapshot({ phase: 'error', detail: message })
      console.error('[bt] controller start failed', err)
    } finally {
      starting = null
    }
  })()
  return starting
}

function poll() {
  if (!ch) return
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
