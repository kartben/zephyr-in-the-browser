/**
 * Browser end of the ESP32-C3's SPI bridge.
 *
 * The SPI counterpart of src/hostI2c.ts, and the same idea: the chips are the
 * TypeScript models the Cortex-A53 reaches over VIRTIO
 * (`src/virtio/devices/`), because `src/virtio/devices/spi.ts` is a bus plus a
 * transport onto it, and this is the second transport. A JEDEC NOR, an LED
 * strip, a character VFD, a stepper driver: all unchanged.
 *
 * Underneath there is no virtio at all. The guest drives the SoC's own GP-SPI2
 * controller with Zephyr's stock `spi_esp32_spim` driver, QEMU models it
 * (hw/ssi/esp32c3_gpspi.c), and `hw/ssi/host_spi.c` sits on its SSI bus as the
 * peripheral on CS0.
 *
 * One request carries one *run*: the bytes the controller clocks without
 * letting go of the select, plus whether the select drops afterwards. That is
 * exactly what {@link SpiChip.transfer} takes, `csChange` included, so a chip
 * whose command spans several runs (a flash reading its status, then its data)
 * sees the same sequence it sees on the virtio bus.
 *
 * Full duplex is why the run, rather than the byte, is the unit: a byte's
 * answer is due before the next one goes out, so a per-byte round trip would
 * cost an LED strip frame hundreds of them.
 */

import { HOST_POLL_MS, register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'
import { spiModel } from '@/virtio'
import type { MainToRequestWaiter, RequestWaiterToMain } from '@/virtio/requestWaitWorker'

/** Byte offsets into HostSpiArea. Must match hw/ssi/host_spi.c. */
const AREA = {
  magic: 0,
  version: 4,
  /** Bit N = the page has a chip on chip select N. */
  present: 8,
  attached: 12,
  reqSeq: 16,
  rspSeq: 20,
  op: 24,
  cs: 28,
  len: 32,
  flags: 36,
  status: 40,
  data: 48,
} as const

const AREA_MAGIC = 0x42535053 /* "SPSB" */
const AREA_VERSION = 1

/** Matches HOST_SPI_BUF. */
const DATA_CAP = 4096

const OP_TRANSFER = 1

/** The controller deasserts the select after this run. */
const F_CS_RELEASE = 1 << 0

const STATUS_OK = 0
const STATUS_ERR = 1

const POLL_ID = 'host-spi'

/**
 * What the page tells a chip about the link when the controller does not say.
 * GP-SPI2's registers carry the clock divider and mode, but no chip model here
 * reads either: they matter to a scope, not to a state machine.
 */
const LINK = { bitsPerWord: 8, mode: 0, freq: 0 } as const

interface SpiExports {
  /** Address of the shared area, or 0 when this machine has no bridge. */
  _qemu_host_spi_area?: () => number
  HEAPU8?: Uint8Array
}

interface Bound {
  base: number
  bytes: Uint8Array
  words: Int32Array
}

let bound: Bound | null = null
let mod: SpiExports | null = null
let waiter: Worker | null = null
let served = 0
let unsubscribeChips: (() => void) | undefined
let pollingFallback = false
const listeners = new Set<() => void>()

function word(b: Bound, offset: number): number {
  return Atomics.load(b.words, (b.base + offset) >> 2)
}

function setWord(b: Bound, offset: number, value: number) {
  Atomics.store(b.words, (b.base + offset) >> 2, value)
}

function notify() {
  for (const fn of listeners) fn()
}

/** Publish which chip selects have a chip, so an empty one costs no round trip. */
function publishPresence() {
  if (!bound) return
  let mask = 0
  for (const chip of spiModel.chips()) {
    if (chip.cs >= 0 && chip.cs < 32) mask |= 1 << chip.cs
  }
  setWord(bound, AREA.present, mask)
}

/** Answer one run: the chip runs here, synchronously, then QEMU resumes. */
function serve(b: Bound, seq: number) {
  const op = word(b, AREA.op) >>> 0
  const cs = word(b, AREA.cs) >>> 0
  const len = Math.min(word(b, AREA.len) >>> 0, DATA_CAP)
  const flags = word(b, AREA.flags) >>> 0

  let ok = false
  if (op === OP_TRANSFER) {
    const data = b.bytes.subarray(b.base + AREA.data, b.base + AREA.data + len)
    // The chip writes rx in place, so give it its own buffers and copy back:
    // a model is entitled to keep the array it was handed.
    const tx = data.slice()
    const rx = new Uint8Array(len)
    ok = spiModel.transferMessage(cs, tx, rx, {
      csChange: (flags & F_CS_RELEASE) !== 0,
      ...LINK,
    })
    if (ok) data.set(rx)
  } else {
    console.warn(`[host-spi] unknown op ${op}`)
  }

  setWord(b, AREA.status, ok ? STATUS_OK : STATUS_ERR)
  setWord(b, AREA.rspSeq, seq)
  Atomics.notify(b.words, (b.base + AREA.rspSeq) >> 2)
  served = seq
}

function drain() {
  const b = bound
  if (!b) return
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

function fallBackToPolling(reason: string) {
  if (pollingFallback) return
  pollingFallback = true
  stopWaiter()
  console.warn(`[host-spi] request waiter unavailable (${reason}); polling at ${HOST_POLL_MS} ms`)
}

/** Look for the area until the machine has realized the bridge. */
function discover() {
  if (bound) {
    if (pollingFallback) drain()
    return
  }
  const base = mod?._qemu_host_spi_area?.() ?? 0
  const heap = mod?.HEAPU8
  if (!base || !heap) return

  const words = new Int32Array(heap.buffer)
  if (Atomics.load(words, base >> 2) !== AREA_MAGIC) {
    console.warn('[host-spi] shared area has the wrong magic; ignoring it')
    mod = null
    return
  }
  const version = Atomics.load(words, (base + AREA.version) >> 2)
  if (version !== AREA_VERSION) {
    console.warn(`[host-spi] emulator speaks protocol ${version}, page speaks ${AREA_VERSION}`)
    mod = null
    return
  }

  bound = { base, bytes: heap, words }
  served = word(bound, AREA.reqSeq)
  publishPresence()
  unsubscribeChips = spiModel.subscribe(publishPresence)
  startWaiter(bound)
  setWord(bound, AREA.attached, 1)
  notify()
}

/**
 * Called by the qemu backend once its module is live. A build or a machine
 * without the bridge simply never discovers an area.
 */
export function attach(instance: unknown) {
  detach()
  mod = instance as SpiExports | null
  registerPoll(POLL_ID, HOST_POLL_MS, discover)
  discover()
}

export function detach() {
  if (bound) {
    setWord(bound, AREA.attached, 0)
    setWord(bound, AREA.present, 0)
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

/** Whether this machine's SPI bus is reaching the page's chips. */
export function available(): boolean {
  return bound !== null
}

/** Bind/unbind notifications, for the dock. See src/hostI2c.ts. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
