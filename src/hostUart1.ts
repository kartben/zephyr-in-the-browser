/**
 * Browser end of uart1's bidirectional chardev (QEMU browser-gnss).
 *
 * RX (page → guest): `_qemu_browser_gnss_feed_byte` — NMEA, TMCL replies, …
 * TX (guest → page): TX ring exports — polled like the QMP monitor channel.
 *
 * GNSS and TMCM-3216 both ride this pipe; only one should drive RX at a time.
 */

const POLL_MS = 16

export interface Uart1Exports {
  _qemu_browser_gnss_feed_byte?: (value: number) => number
  _qemu_browser_gnss_tx_ring?: () => number
  _qemu_browser_gnss_tx_ring_size?: () => number
  _qemu_browser_gnss_tx_write_index?: () => number
  _qemu_browser_gnss_tx_read_index?: () => number
  _qemu_browser_gnss_tx_set_read_index?: (value: number) => void
  HEAPU8?: Uint8Array
}

type TxListener = (bytes: Uint8Array) => void

let exports: Uart1Exports | null = null
let poll: ReturnType<typeof setInterval> | undefined
const txListeners = new Set<TxListener>()

export function attach(mod: unknown) {
  detach()
  exports = mod as Uart1Exports
  if (txCaptureAvailable()) {
    poll = setInterval(drainTx, POLL_MS)
  }
}

export function detach() {
  if (poll !== undefined) clearInterval(poll)
  poll = undefined
  exports = null
}

/** Emulator has the RX feed (every browser-gnss build). */
export function feedAvailable(): boolean {
  return typeof exports?._qemu_browser_gnss_feed_byte === 'function'
}

/** Emulator exposes the TX ring (rebuild with TX-capture patch). */
export function txCaptureAvailable(): boolean {
  return typeof exports?._qemu_browser_gnss_tx_ring === 'function'
}

/** Queue bytes toward the guest UART RX FIFO. */
export function feed(bytes: ArrayLike<number>): void {
  const write = exports?._qemu_browser_gnss_feed_byte
  if (!write) return
  for (let i = 0; i < bytes.length; i++) write(bytes[i]!)
}

export function feedByte(value: number): void {
  exports?._qemu_browser_gnss_feed_byte?.(value & 0xff)
}

/** Subscribe to guest TX bursts (raw UART bytes, post-echo side-channel). */
export function onTx(fn: TxListener): () => void {
  txListeners.add(fn)
  return () => txListeners.delete(fn)
}

function drainTx() {
  const mod = exports
  const ringFn = mod?._qemu_browser_gnss_tx_ring
  const sizeFn = mod?._qemu_browser_gnss_tx_ring_size
  const writeFn = mod?._qemu_browser_gnss_tx_write_index
  const readFn = mod?._qemu_browser_gnss_tx_read_index
  const setReadFn = mod?._qemu_browser_gnss_tx_set_read_index
  const heap = mod?.HEAPU8
  if (!ringFn || !sizeFn || !writeFn || !readFn || !setReadFn || !heap) return

  const base = ringFn()
  const size = sizeFn()
  if (!base || size <= 0) return

  let read = readFn() >>> 0
  const write = writeFn() >>> 0
  if (read === write) return

  const count = write - read
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    out[i] = heap[(base + ((read + i) % size)) >>> 0]!
  }
  setReadFn(write)

  for (const fn of txListeners) fn(out)
}
