/**
 * VIRTIO I2C adapter device model (virtio spec 1.3, section 5.15), in the page.
 *
 * This is the first device that exists *only* here — there is no C device model
 * for it in QEMU and there never will be, because the generic bridge carries
 * it. Adding an I2C chip is a TypeScript file and a `attachChip` call; no
 * emulator rebuild is involved.
 *
 * The wire shape is one descriptor chain per `struct i2c_msg`, so a Zephyr
 * `i2c_transfer` of N messages arrives here as N requests. Each carries:
 *
 *     out: struct virtio_i2c_out_hdr { le16 addr; le16 padding; le32 flags; }
 *          followed by the bytes to write, when this is a write
 *     in:  the bytes read, when this is a read,
 *          followed by struct virtio_i2c_in_hdr { u8 status; }
 *
 * `addr` is the 7-bit address shifted left by one — the byte as it goes out on
 * the wire, with room for the R/W bit — which is what Linux's driver sends and
 * what the spec's examples show.
 *
 * A chip that is not attached NAKs, which is what makes `i2c scan` a real scan
 * rather than a list of everything: the guest sees exactly the addresses the
 * page is answering for.
 */

import type { VirtioDeviceModel, VirtioRequest } from '../transport'

/** Only one queue: requests. */
const VQ_REQUEST = 0

const OUT_HDR_BYTES = 8

/** Fail the following request too, if this one fails. */
const FLAGS_FAIL_NEXT = 1 << 0
/** This message is a read; otherwise it is a write. */
const FLAGS_M_RD = 1 << 1

const MSG_OK = 0
const MSG_ERR = 1

/** How many transactions the log keeps, newest last. */
const LOG_CAP = 500

/**
 * Cap how often transaction-log subscribers (the I²C traffic pane) re-render.
 * Accel chart samples the ADXL over virtio-i2c many times a second; rebuilding
 * a log array and waking React on every message steals the main thread from
 * qemu-wasm. Attach/detach still notify immediately.
 */
const LOG_NOTIFY_MS = 50

/**
 * Bytes kept per log entry. The traffic pane shows six; a little headroom is
 * enough for debug without copying full OLED frame chunks into the ring.
 */
const LOG_BYTE_CAP = 8

export interface I2cChip {
  /** 7-bit address. */
  readonly address: number
  /** Shown in the panel and the transaction log. */
  readonly name: string
  /**
   * The guest wrote these bytes. Return false to NAK — a real chip NAKs a
   * write it cannot accept, and drivers do notice.
   */
  write?(bytes: Uint8Array): boolean | void
  /**
   * The guest wants `length` bytes. Return null to NAK. Returning fewer bytes
   * than asked pads with 0xff, which is what an open bus reads as.
   */
  read?(length: number): Uint8Array | null | undefined
}

export interface I2cTransaction {
  id: number
  /** 7-bit address. */
  address: number
  dir: 'read' | 'write'
  /**
   * Payload bytes for the trace (may be truncated — see {@link byteLength}).
   * DAC fast-writes are 2 bytes; OLED chunks are capped at {@link LOG_BYTE_CAP}.
   */
  bytes: Uint8Array
  /** Full payload length on the wire, before truncation for the log. */
  byteLength: number
  ok: boolean
  /** Name of the chip that answered, or null when nothing did. */
  chip: string | null
}

export interface I2cModel extends VirtioDeviceModel {
  /** Put a chip on the bus. Returns a function that removes it again. */
  attachChip(chip: I2cChip): () => void
  /** Take whatever chip is at `address` off the bus. A no-op if none is. */
  detachChip(address: number): void
  chips(): I2cChip[]
  transactions(): readonly I2cTransaction[]
  clearTransactions(): void
  subscribe(fn: () => void): () => void
  /** Monotonic count of logged transactions — for the display profiler. */
  transactionCount(): number
}

function copyLogBytes(src: Uint8Array): { bytes: Uint8Array; byteLength: number } {
  const byteLength = src.length
  if (byteLength <= LOG_BYTE_CAP) {
    return { bytes: src.slice(), byteLength }
  }
  return { bytes: src.slice(0, LOG_BYTE_CAP), byteLength }
}

export function createI2cModel(name = 'i2c'): I2cModel {
  const bus = new Map<number, I2cChip>()
  const listeners = new Set<() => void>()
  /**
   * Fixed ring — push is O(1). The previous `array + splice(0, …)` form shifted
   * every retained entry on each write once the cap filled; at 1 kHz (stock DAC
   * sawtooth) that alone burned the main thread and the chart lagged the guest.
   */
  const log: (I2cTransaction | undefined)[] = new Array(LOG_CAP)
  let logHead = 0
  let logLen = 0
  let logSnapshot: I2cTransaction[] = []
  let nextId = 1
  let logNotifyTimer: ReturnType<typeof setTimeout> | undefined
  let logDirty = false

  /*
   * Snapshots for useSyncExternalStore, which compares with Object.is. Both
   * halves of that contract bite: a getter that builds a fresh array every
   * call spins React forever, and one that mutates in place never re-renders.
   * So these are rebuilt exactly when their contents change, and returned
   * as-is otherwise.
   */
  let chipsSnapshot: I2cChip[] = []
  const refreshChips = () => {
    chipsSnapshot = [...bus.values()].sort((a, b) => a.address - b.address)
  }

  /**
   * Set while a transfer is being failed off. The driver sets FAIL_NEXT on
   * every message but the last, so a failure partway through must take the
   * rest of that transfer with it rather than letting later messages land on
   * a chip that never saw the earlier ones.
   */
  let failing = false

  const notify = () => {
    for (const fn of listeners) fn()
  }

  const materializeLog = (): I2cTransaction[] => {
    const snap: I2cTransaction[] = new Array(logLen)
    for (let i = 0; i < logLen; i++) {
      snap[i] = log[(logHead + i) % LOG_CAP]!
    }
    return snap
  }

  const publishLog = () => {
    logNotifyTimer = undefined
    if (!logDirty) return
    logDirty = false
    logSnapshot = materializeLog()
    notify()
  }

  const scheduleLogNotify = () => {
    logDirty = true
    // No subscribers → nothing to wake. The ring still fills so opening the
    // traffic pane later still has history; transactions() materializes on
    // read when dirty. Skipping the timer at 1 kHz DAC keeps a setTimeout
    // off the main thread when the I²C panel is not mounted.
    if (listeners.size === 0 || logNotifyTimer !== undefined) return
    logNotifyTimer = setTimeout(publishLog, LOG_NOTIFY_MS)
  }

  function record(entry: Omit<I2cTransaction, 'id'>) {
    const row: I2cTransaction = { id: nextId++, ...entry }
    if (logLen < LOG_CAP) {
      log[(logHead + logLen) % LOG_CAP] = row
      logLen++
    } else {
      log[logHead] = row
      logHead = (logHead + 1) % LOG_CAP
    }
    scheduleLogNotify()
  }

  function handle(req: VirtioRequest) {
    if (req.queue !== VQ_REQUEST) {
      console.warn(`[virtio-i2c] request on unexpected queue ${req.queue}`)
      req.fail()
      return
    }
    if (req.out.length < OUT_HDR_BYTES || req.inCap < 1) {
      console.warn('[virtio-i2c] malformed chain')
      req.fail()
      return
    }

    const dv = new DataView(req.out.buffer, req.out.byteOffset, req.out.byteLength)
    // The address goes out shifted, leaving room for the R/W bit.
    const address = dv.getUint16(0, true) >> 1
    const flags = dv.getUint32(4, true)
    const isRead = (flags & FLAGS_M_RD) !== 0
    const failNext = (flags & FLAGS_FAIL_NEXT) !== 0

    /** Answer the chain: read payload (if any) then the status byte. */
    const answer = (ok: boolean, payload?: Uint8Array) => {
      const readLen = isRead ? req.inCap - 1 : 0
      const out = new Uint8Array(readLen + 1)
      if (ok && payload) out.set(payload.subarray(0, readLen), 0)
      else if (isRead) out.fill(0xff, 0, readLen)
      out[readLen] = ok ? MSG_OK : MSG_ERR
      req.reply(out)

      // FAIL_NEXT is only meaningful while more messages of this transfer are
      // still coming; the last message clears it either way.
      failing = ok ? false : failNext
    }

    if (failing) {
      answer(false)
      return
    }

    const chip = bus.get(address)
    if (!chip) {
      // Nothing at this address. Deliberately not logged: `i2c scan` probes
      // 116 addresses and would bury every real transaction under NAKs.
      answer(false)
      return
    }

    if (isRead) {
      const length = req.inCap - 1
      const data = chip.read?.(length)
      const ok = data != null
      answer(ok, data ?? undefined)
      const logged = ok ? copyLogBytes((data as Uint8Array).subarray(0, length)) : { bytes: new Uint8Array(), byteLength: 0 }
      record({
        address,
        dir: 'read',
        bytes: logged.bytes,
        byteLength: logged.byteLength,
        ok,
        chip: chip.name,
      })
      return
    }

    const payload = req.out.subarray(OUT_HDR_BYTES)
    const ok = chip.write?.(payload) !== false
    answer(ok)
    const logged = copyLogBytes(payload)
    record({
      address,
      dir: 'write',
      bytes: logged.bytes,
      byteLength: logged.byteLength,
      ok,
      chip: chip.name,
    })
  }

  return {
    name,
    handle,

    reset() {
      failing = false
    },

    attachChip(chip) {
      if (bus.has(chip.address)) {
        throw new Error(
          `i2c: 0x${chip.address.toString(16)} is already taken by ${bus.get(chip.address)!.name}`,
        )
      }
      bus.set(chip.address, chip)
      refreshChips()
      notify()
      return () => {
        if (bus.get(chip.address) === chip) {
          bus.delete(chip.address)
          refreshChips()
          notify()
        }
      }
    },

    detachChip(address) {
      if (bus.delete(address)) {
        refreshChips()
        notify()
      }
    },

    chips: () => chipsSnapshot,
    transactions() {
      // Direct readers (tests) flush so they see the latest entry without
      // waiting out the UI throttle. React only reaches this after publishLog
      // has notified, when the snapshot is already fresh and stable.
      if (logDirty) {
        if (logNotifyTimer !== undefined) {
          clearTimeout(logNotifyTimer)
          logNotifyTimer = undefined
        }
        logDirty = false
        logSnapshot = materializeLog()
      }
      return logSnapshot
    },
    clearTransactions() {
      logHead = 0
      logLen = 0
      logSnapshot = []
      logDirty = false
      if (logNotifyTimer !== undefined) {
        clearTimeout(logNotifyTimer)
        logNotifyTimer = undefined
      }
      notify()
    },

    transactionCount: () => nextId - 1,

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
