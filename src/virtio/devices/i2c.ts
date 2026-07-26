/**
 * Page-side VIRTIO I2C adapter. Each Zephyr `i2c_msg` arrives as one request
 * with a virtio_i2c_out_hdr, optional write/read bytes, and an in_hdr status.
 * `addr` is the 7-bit address shifted left; unattached chips NAK.
 */

import type { VirtioDeviceModel, VirtioRequest } from '../transport'

const VQ_REQUEST = 0

const OUT_HDR_BYTES = 8

const FLAGS_FAIL_NEXT = 1 << 0
const FLAGS_M_RD = 1 << 1

const MSG_OK = 0
const MSG_ERR = 1

const LOG_CAP = 500

/**
 * Throttle traffic-pane renders; high-rate I2C sampling can otherwise starve
 * qemu-wasm on the main thread.
 */
const LOG_NOTIFY_MS = 50

/** Avoid copying full OLED frame chunks into the transaction log. */
const LOG_BYTE_CAP = 8

export interface I2cChip {
  readonly address: number
  readonly name: string
  /** Return false to NAK a write. */
  write?(bytes: Uint8Array): boolean | void
  /** Return null to NAK; short reads pad with 0xff open-bus bytes. */
  read?(length: number): Uint8Array | null | undefined
}

export interface I2cTransaction {
  id: number
  address: number
  dir: 'read' | 'write'
  bytes: Uint8Array
  byteLength: number
  ok: boolean
  chip: string | null
}

export interface I2cModel extends VirtioDeviceModel {
  attachChip(chip: I2cChip): () => void
  detachChip(address: number): void
  chips(): I2cChip[]
  transactions(): readonly I2cTransaction[]
  clearTransactions(): void
  subscribe(fn: () => void): () => void
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
  /** Fixed ring: log writes stay O(1) under high-rate traffic. */
  const log: (I2cTransaction | undefined)[] = new Array(LOG_CAP)
  let logHead = 0
  let logLen = 0
  let logSnapshot: I2cTransaction[] = []
  let nextId = 1
  let logNotifyTimer: ReturnType<typeof setTimeout> | undefined
  let logDirty = false

  /** useSyncExternalStore needs stable snapshots until contents change. */
  let chipsSnapshot: I2cChip[] = []
  const refreshChips = () => {
    chipsSnapshot = [...bus.values()].sort((a, b) => a.address - b.address)
  }

  /**
   * FAIL_NEXT means a mid-transfer failure must fail the remaining messages too.
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
    if (logNotifyTimer !== undefined) return
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
    const address = dv.getUint16(0, true) >> 1
    const flags = dv.getUint32(4, true)
    const isRead = (flags & FLAGS_M_RD) !== 0
    const failNext = (flags & FLAGS_FAIL_NEXT) !== 0

    const answer = (ok: boolean, payload?: Uint8Array) => {
      const readLen = isRead ? req.inCap - 1 : 0
      const out = new Uint8Array(readLen + 1)
      if (ok && payload) out.set(payload.subarray(0, readLen), 0)
      else if (isRead) out.fill(0xff, 0, readLen)
      out[readLen] = ok ? MSG_OK : MSG_ERR
      req.reply(out)

      // The last message clears FAIL_NEXT state either way.
      failing = ok ? false : failNext
    }

    if (failing) {
      answer(false)
      return
    }

    const chip = bus.get(address)
    if (!chip) {
      // Do not log scan NAKs; they bury real transactions.
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
      // Tests bypass the UI throttle; React sees already-published snapshots.
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
