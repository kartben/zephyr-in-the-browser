/**
 * SPIKE glue — instantiates virtioAtomicsWorker.ts and wires it to a live
 * QEMU module. Not part of the normal boot path; see
 * src/backends/qemu.ts for the `?virtioWorker=1` gate that reaches this
 * instead of the production `attach()` in src/virtio/index.ts.
 *
 * Only exists to answer the question docs/performance.md item 1(b)/(c) left
 * open: with the bridge's hot loop moved into a worker blocking on
 * `Atomics.wait`, paired with a QEMU-side wasm-memory-notify on `req_wr`, how
 * close does the round trip get to sub-millisecond? It measures that; it does
 * not replace the production virtio bridge, which still needs to cover every
 * other device model (see the worker file's own header for what's missing).
 */

import { AREA, AREA_MAGIC, AREA_VERSION, readName } from '../protocol'
import type { MainToWorker, WorkerToMain } from './virtioAtomicsWorker'

interface SpikeExports {
  _qemu_virtio_browser_count?: () => number
  _qemu_virtio_browser_area?: (index: number) => number
  _qemu_virtio_browser_wake_addr?: () => number
  _qemu_virtio_browser_kick?: () => void
  HEAPU8?: Uint8Array
}

export interface AtomicsSpikeStats {
  requests: number
  wallMs: number
  waitWakes: number
  waitTimeouts: number
  kicks: number
  /** ms from the worker posting 'kick' to this handler receiving it. */
  relayAvgMs: number
  relayMaxMs: number
}

let worker: Worker | null = null
let lastStats: AtomicsSpikeStats | null = null
let kicksSeen = 0
let relaySumMs = 0
let relayMaxMs = 0
/**
 * mainThreadNow - workerNow, from the 'ready' handshake. Needed because a
 * worker's performance.now() origin is not reliably the same instant as the
 * main thread's in every engine/dev-server combination — an uncalibrated
 * diff was landing at a suspiciously exact ~532ms on every single sample,
 * the signature of a fixed origin mismatch rather than real latency.
 */
let clockOffsetMs = 0

/** Discovery polls at this pace until the "i2c" device shows up. */
const DISCOVERY_POLL_MS = 20
const DISCOVERY_TIMEOUT_MS = 10_000

function findI2cArea(mod: SpikeExports): number | null {
  const count = mod._qemu_virtio_browser_count?.() ?? 0
  const heap = mod.HEAPU8
  if (!count || !heap || !mod._qemu_virtio_browser_area) return null
  const view = new DataView(heap.buffer)
  for (let i = 0; i < count; i++) {
    const areaBase = mod._qemu_virtio_browser_area(i)
    if (!areaBase) continue
    if (view.getUint32(areaBase + AREA.magic, true) !== AREA_MAGIC) continue
    if (view.getUint32(areaBase + AREA.version, true) !== AREA_VERSION) continue
    if (readName(heap, areaBase) === 'i2c') return areaBase
  }
  return null
}

export function attachAtomicsSpike(mod: unknown): void {
  detachAtomicsSpike()
  const exports = mod as SpikeExports
  const start = performance.now()

  const tryAttach = () => {
    const areaBase = findI2cArea(exports)
    if (areaBase == null) {
      if (performance.now() - start > DISCOVERY_TIMEOUT_MS) {
        console.error('[virtio-spike] gave up waiting for the "i2c" device to appear')
        return
      }
      setTimeout(tryAttach, DISCOVERY_POLL_MS)
      return
    }

    const heap = exports.HEAPU8!
    const wakeAddr = exports._qemu_virtio_browser_wake_addr?.() ?? 0
    const wakeWordIndex = wakeAddr > 0 && (wakeAddr & 3) === 0 ? wakeAddr >> 2 : -1

    worker = new Worker(new URL('./virtioAtomicsWorker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent) => {
      const message = event.data as WorkerToMain
      if (message.type === 'kick') {
        kicksSeen += 1
        const relayMs = performance.now() - (message.postedAt + clockOffsetMs)
        relaySumMs += relayMs
        if (relayMs > relayMaxMs) relayMaxMs = relayMs
        try {
          exports._qemu_virtio_browser_kick?.()
        } catch (err) {
          console.error('[virtio-spike] kick failed', err)
        }
      } else if (message.type === 'stats') {
        lastStats = {
          requests: message.requests,
          wallMs: message.wallMs,
          waitWakes: message.waitWakes,
          waitTimeouts: message.waitTimeouts,
          relayAvgMs: kicksSeen ? relaySumMs / kicksSeen : -1,
          relayMaxMs,
          kicks: kicksSeen,
        }
      } else if (message.type === 'fatal') {
        console.error('[virtio-spike] worker fatal:', message.message)
      } else if (message.type === 'ready') {
        clockOffsetMs = performance.now() - message.workerNow
        console.info(
          '[virtio-spike] worker attached to "i2c" device, area',
          areaBase,
          'clockOffsetMs',
          clockOffsetMs.toFixed(3),
        )
      }
    })

    const init: MainToWorker = { type: 'init', buffer: heap.buffer, areaBase, wakeWordIndex }
    worker.postMessage(init)
  }

  tryAttach()
}

export function detachAtomicsSpike(): void {
  // terminate(), not a 'stop' message: see virtioAtomicsWorker.ts's header
  // for why the message queue is not a reliable shutdown path once the
  // Atomics.wait loop is running.
  worker?.terminate()
  worker = null
  lastStats = null
  kicksSeen = 0
  relaySumMs = 0
  relayMaxMs = 0
}

export function atomicsSpikeStats(): AtomicsSpikeStats | null {
  return lastStats
}

// Measurement seam, mirrors window.__zephyrProfile — read from tooling, not
// from the app itself.
declare global {
  interface Window {
    __virtioAtomicsSpike?: { stats: () => AtomicsSpikeStats | null }
  }
}
window.__virtioAtomicsSpike = { stats: atomicsSpikeStats }
