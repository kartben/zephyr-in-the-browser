/**
 * Browser end of the ESP32-C3's I2C bridge.
 *
 * The chips this serves are the same TypeScript models the Cortex-A53 reaches
 * over VIRTIO (`src/virtio/devices/`), because `src/virtio/devices/i2c.ts` is
 * two things: a bus (the chip registry, the traffic log, and the three calls
 * below) and a transport onto it. This module is the second transport. Nothing
 * about an EEPROM, a thermometer or an OLED is repeated here.
 *
 * It looks nothing like the virtio one because the machine it serves has
 * neither a virtio bus nor PCI. The guest drives the SoC's own I2C controller
 * with Zephyr's stock `i2c_esp32` driver, QEMU models that controller, and
 * `hw/i2c/host_i2c.c` sits on its I2CBus as the slave that answers for every
 * address the page is modelling. So the guest is not aware of any of this: it
 * is talking to a peripheral its datasheet describes.
 *
 * Two things cross the boundary, through one struct in the wasm heap.
 *
 * - **Which addresses answer**, as a 128-bit mask this module publishes on
 *   every attach and detach. Presence is asked on every transfer and 116 times
 *   by one `i2c scan`, so it is a shared-memory load in QEMU rather than a
 *   round trip.
 *
 * - **The transfers**, one at a time. QEMU fills the request in and parks the
 *   guest's thread on a futex; a worker blocked in `Atomics.wait` wakes this
 *   thread, the chip model answers synchronously, and the answer is published
 *   back. The models stay here rather than moving into the worker for the same
 *   reason the virtio ones do: several own browser-only state (localStorage,
 *   device orientation, UI subscriptions).
 *
 * A read message can arrive in more than one piece: the driver splits a read
 * of N bytes into N-1 and 1 so it can NAK the last one. QEMU flags the piece
 * that opens a message, and that becomes {@link I2cChip.startRead} on the bus,
 * so a chip whose read position is scoped to a message rewinds at the right
 * moment. The traffic pane shows the pieces, because that is what happened on
 * the wire.
 */

import { HOST_POLL_MS, register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'
import { i2cModel } from '@/virtio'
import type { MainToRequestWaiter, RequestWaiterToMain } from '@/virtio/requestWaitWorker'

/** Byte offsets into HostI2cArea. Must match hw/i2c/host_i2c.c. */
const AREA = {
  magic: 0,
  version: 4,
  /** 4 words, bit N of word N>>5 = a chip answers at 7-bit address N. */
  present: 8,
  attached: 24,
  reqSeq: 28,
  rspSeq: 32,
  op: 36,
  addr: 40,
  len: 44,
  flags: 48,
  status: 52,
  data: 60,
} as const

const AREA_MAGIC = 0x42433249 /* "I2CB" */
const AREA_VERSION = 1

/**
 * Matches HOST_I2C_BUF. A read run cannot exceed 255 bytes, but a write is a
 * whole message: a display pushing a full 128x64 frame is 1025 bytes.
 */
const DATA_CAP = 4096

const OP_WRITE = 1
const OP_READ = 2

/** This read opens a message; the bus turns it into I2cChip.startRead. */
const F_FIRST = 1 << 0

const STATUS_ACK = 0
const STATUS_NAK = 1

/** What an unanswered byte reads as on an open bus. */
const OPEN_BUS = 0xff

/** Discovery beat: the machine is realized some time after the module loads. */
const POLL_ID = 'host-i2c'

interface I2cExports {
  /** Address of the shared area, or 0 when this machine has no bridge. */
  _qemu_host_i2c_area?: () => number
  HEAPU8?: Uint8Array
}

interface Bound {
  base: number
  bytes: Uint8Array
  words: Int32Array
}

let bound: Bound | null = null
let mod: I2cExports | null = null
let waiter: Worker | null = null
/** Sequence number of the last request answered. */
let served = 0
let unsubscribeChips: (() => void) | undefined
/** Notified when the bridge binds or lets go, so the dock can follow. */
const listeners = new Set<() => void>()
/** Set while the waiter is gone and the shared beat is covering for it. */
let pollingFallback = false

/** Both take a byte offset into the area, not into the heap. */
function word(b: Bound, offset: number): number {
  return Atomics.load(b.words, (b.base + offset) >> 2)
}

function setWord(b: Bound, offset: number, value: number) {
  Atomics.store(b.words, (b.base + offset) >> 2, value)
}

/**
 * Publish which addresses answer. QEMU reads this on every transfer without
 * asking us, which is what keeps `i2c scan` free.
 */
function publishPresence() {
  if (!bound) return
  const mask = [0, 0, 0, 0]
  for (const chip of i2cModel.chips()) {
    const address = chip.address & 0x7f
    mask[address >> 5]! |= 1 << (address & 31)
  }
  for (let i = 0; i < 4; i++) {
    setWord(bound, AREA.present + i * 4, mask[i]! | 0)
  }
}

function clearPresence(b: Bound) {
  for (let i = 0; i < 4; i++) setWord(b, AREA.present + i * 4, 0)
}

/** Answer one request: the chip runs here, synchronously, then QEMU resumes. */
function serve(b: Bound, seq: number) {
  const op = word(b, AREA.op) >>> 0
  const address = word(b, AREA.addr) >>> 0
  const len = Math.min(word(b, AREA.len) >>> 0, DATA_CAP)
  const flags = word(b, AREA.flags) >>> 0
  const data = b.bytes.subarray(b.base + AREA.data, b.base + AREA.data + DATA_CAP)

  let ok = false
  if (op === OP_WRITE) {
    ok = i2cModel.writeMessage(address, data.slice(0, len))
  } else if (op === OP_READ) {
    const answer = i2cModel.readMessage(address, len, (flags & F_FIRST) !== 0)
    if (answer) {
      // A chip that answers short leaves the rest of the run open.
      data.fill(OPEN_BUS, 0, len)
      data.set(answer.subarray(0, len), 0)
      ok = true
    }
  } else {
    console.warn(`[host-i2c] unknown op ${op}`)
  }

  setWord(b, AREA.status, ok ? STATUS_ACK : STATUS_NAK)
  // Publishing the sequence is what releases the guest, so it goes last.
  setWord(b, AREA.rspSeq, seq)
  Atomics.notify(b.words, (b.base + AREA.rspSeq) >> 2)
  served = seq
}

/** Drain whatever QEMU has posted since the last wake. */
function drain() {
  const b = bound
  if (!b) return
  // One request is in flight at a time (QEMU is parked until it is answered),
  // so this loops at most once, but a coalesced wake must not lose it.
  for (let guard = 0; guard < 8; guard++) {
    const seq = word(b, AREA.reqSeq)
    if (seq === served) return
    serve(b, seq)
  }
}

function stopWaiter() {
  waiter?.terminate()
  waiter = null
}

/**
 * A worker may block in Atomics.wait() on the request word; this thread may
 * not. Each wake arrives as an ordinary message, which is enough to run the
 * chip models here.
 */
function startWaiter(b: Bound) {
  stopWaiter()
  try {
    const wordIndex = (b.base + AREA.reqSeq) >> 2
    const worker = new Worker(new URL('./virtio/requestWaitWorker.ts', import.meta.url), {
      type: 'module',
    })
    waiter = worker
    worker.onmessage = (event: MessageEvent<RequestWaiterToMain>) => {
      if (event.data.type === 'wake') drain()
      else if (event.data.type === 'fatal') fallBackToPolling(event.data.message)
    }
    worker.onerror = (event) => fallBackToPolling(event.message || 'worker error')
    const message: MainToRequestWaiter = {
      type: 'start',
      buffer: b.words.buffer as SharedArrayBuffer,
      wordIndex,
      expected: Atomics.load(b.words, wordIndex),
    }
    worker.postMessage(message)
  } catch (error) {
    fallBackToPolling(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Without a waiter the guest still gets answers, just at the shared beat,
 * which shows up as a slow bus rather than a broken one. QEMU's own 250 ms
 * timeout is well clear of 100 ms, so nothing NAKs.
 */
function fallBackToPolling(reason: string) {
  if (pollingFallback) return
  pollingFallback = true
  stopWaiter()
  console.warn(`[host-i2c] request waiter unavailable (${reason}); polling at ${HOST_POLL_MS} ms`)
}

/** Look for the area until the machine has realized the bridge. */
function discover() {
  if (bound) {
    if (pollingFallback) drain()
    return
  }
  const base = mod?._qemu_host_i2c_area?.() ?? 0
  const heap = mod?.HEAPU8
  if (!base || !heap) return

  const words = new Int32Array(heap.buffer)
  if (Atomics.load(words, base >> 2) !== AREA_MAGIC) {
    console.warn('[host-i2c] shared area has the wrong magic; ignoring it')
    mod = null
    return
  }
  const version = Atomics.load(words, (base + AREA.version) >> 2)
  if (version !== AREA_VERSION) {
    console.warn(`[host-i2c] emulator speaks protocol ${version}, page speaks ${AREA_VERSION}`)
    mod = null
    return
  }

  bound = { base, bytes: heap, words }
  served = word(bound, AREA.reqSeq)
  publishPresence()
  unsubscribeChips = i2cModel.subscribe(publishPresence)
  startWaiter(bound)
  // Last: until this is set QEMU answers every transfer itself (as an empty
  // bus), so nothing can be waiting on a page that is not listening yet.
  setWord(bound, AREA.attached, 1)
  notify()
}

function notify() {
  for (const fn of listeners) fn()
}

/**
 * Called by the qemu backend once its module is live. A build or a machine
 * without the bridge simply never discovers an area, which `available()`
 * reports.
 */
export function attach(instance: unknown) {
  detach()
  mod = instance as I2cExports | null
  registerPoll(POLL_ID, HOST_POLL_MS, discover)
  discover()
}

export function detach() {
  if (bound) {
    // Order matters the other way round on the way out: stop QEMU asking
    // before there is nobody left to answer.
    setWord(bound, AREA.attached, 0)
    clearPresence(bound)
  }
  unregisterPoll(POLL_ID)
  stopWaiter()
  unsubscribeChips?.()
  unsubscribeChips = undefined
  const wasBound = bound !== null
  bound = null
  mod = null
  served = 0
  pollingFallback = false
  if (wasBound) notify()
}

/** Whether this machine's I2C bus is reaching the page's chips. */
export function available(): boolean {
  return bound !== null
}

/**
 * Bind/unbind notifications, for the dock: a bus is live when *either*
 * transport is up, and this is the one the ESP32-C3 comes up on.
 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
