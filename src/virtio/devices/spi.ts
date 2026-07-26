/**
 * VIRTIO SPI controller device model (virtio SPI controller, device id 45).
 *
 * Same shape as the I²C adapter: one request queue on the generic browser
 * bridge, chips modelled in TypeScript and selected by chip-select id (`reg`
 * in the guest DT), no QEMU device of their own.
 *
 * Wire format per transfer (guest driver → device):
 *
 *     out: struct virtio_spi_transfer_head (32 bytes)
 *          followed by TX bytes, when this half has a TX buffer
 *     in:  RX bytes, when this half has an RX buffer,
 *          followed by a 1-byte result (TRANS_OK / PARAM_ERR / TRANS_ERR)
 *
 * Full-duplex transfers carry both; lengths must match. Half-duplex write or
 * read omit the unused side. A chip that is not attached fails the transfer —
 * SPI has no NAK, so the guest sees TRANS_ERR rather than a quiet bus.
 */

import type { VirtioDeviceModel, VirtioRequest } from '../transport'

const VQ_REQUEST = 0

/** sizeof(struct virtio_spi_transfer_head) */
const HEAD_BYTES = 32

const TRANS_OK = 0
const TRANS_PARAM_ERR = 1
const TRANS_ERR = 2

const LOG_CAP = 500
const LOG_NOTIFY_MS = 50
const LOG_BYTE_CAP = 8

export interface SpiTransferOpts {
  /** Deassert CS after this transfer (virtio_spi_transfer_head.cs_change). */
  csChange: boolean
  bitsPerWord: number
  mode: number
  freq: number
}

/**
 * A chip on a chip-select line. `transfer` is full-duplex: for each clock the
 * device shifts one TX byte out and one RX byte in. Half-duplex is the same
 * shape with the unused side zero-filled / discarded by the caller.
 */
export interface SpiChip {
  /** Chip-select index (`reg` in the guest DT). */
  readonly cs: number
  readonly name: string
  /**
   * Exchange `tx` for `rx` (same length). Return false to fail the transfer
   * (TRANS_ERR). Mutate `rx` in place.
   */
  transfer(tx: Uint8Array, rx: Uint8Array, opts: SpiTransferOpts): boolean | void
}

export interface SpiTransaction {
  id: number
  cs: number
  /** Bytes shifted out (may be truncated — see {@link byteLength}). */
  tx: Uint8Array
  /** Bytes shifted in (may be truncated). */
  rx: Uint8Array
  byteLength: number
  ok: boolean
  chip: string | null
  csChange: boolean
}

export interface SpiModel extends VirtioDeviceModel {
  attachChip(chip: SpiChip): () => void
  detachChip(cs: number): void
  chips(): SpiChip[]
  transactions(): readonly SpiTransaction[]
  clearTransactions(): void
  subscribe(fn: () => void): () => void
  transactionCount(): number
  /** Config-space CS count, once the bridge has attached config. */
  csMaxNumber(): number
}

function copyLogBytes(src: Uint8Array): { bytes: Uint8Array; byteLength: number } {
  const byteLength = src.length
  if (byteLength <= LOG_BYTE_CAP) {
    return { bytes: src.slice(), byteLength }
  }
  return { bytes: src.slice(0, LOG_BYTE_CAP), byteLength }
}

export function createSpiModel(name = 'spi'): SpiModel {
  const bus = new Map<number, SpiChip>()
  const listeners = new Set<() => void>()
  const log: (SpiTransaction | undefined)[] = new Array(LOG_CAP)
  let logHead = 0
  let logLen = 0
  let logSnapshot: SpiTransaction[] = []
  let nextId = 1
  let logNotifyTimer: ReturnType<typeof setTimeout> | undefined
  let logDirty = false
  let chipsSnapshot: SpiChip[] = []
  let csMax = 4

  const refreshChips = () => {
    chipsSnapshot = [...bus.values()].sort((a, b) => a.cs - b.cs)
  }

  const notify = () => {
    for (const fn of listeners) fn()
  }

  const materializeLog = (): SpiTransaction[] => {
    const snap: SpiTransaction[] = new Array(logLen)
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

  function record(entry: Omit<SpiTransaction, 'id'>) {
    const row: SpiTransaction = { id: nextId++, ...entry }
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
      console.warn(`[virtio-spi] request on unexpected queue ${req.queue}`)
      req.fail()
      return
    }
    if (req.out.length < HEAD_BYTES || req.inCap < 1) {
      console.warn('[virtio-spi] malformed chain')
      req.fail()
      return
    }

    const dv = new DataView(req.out.buffer, req.out.byteOffset, req.out.byteLength)
    const cs = dv.getUint8(0)
    const bitsPerWord = dv.getUint8(1)
    const csChange = dv.getUint8(2) !== 0
    const mode = dv.getUint32(8, true)
    const freq = dv.getUint32(12, true)

    const txPayload = req.out.subarray(HEAD_BYTES)
    const rxLen = req.inCap - 1

    // Full duplex requires equal lengths; half duplex has one side empty.
    if (txPayload.length > 0 && rxLen > 0 && txPayload.length !== rxLen) {
      const out = new Uint8Array(req.inCap)
      out[req.inCap - 1] = TRANS_PARAM_ERR
      req.reply(out)
      record({
        cs,
        tx: copyLogBytes(txPayload).bytes,
        rx: new Uint8Array(),
        byteLength: Math.max(txPayload.length, rxLen),
        ok: false,
        chip: null,
        csChange,
      })
      return
    }

    const len = Math.max(txPayload.length, rxLen)
    const tx = new Uint8Array(len)
    if (txPayload.length > 0) tx.set(txPayload)
    const rx = new Uint8Array(len)

    const chip = bus.get(cs)
    let ok = false
    if (chip) {
      ok = chip.transfer(tx, rx, { csChange, bitsPerWord, mode, freq }) !== false
    }

    const out = new Uint8Array(req.inCap)
    if (ok && rxLen > 0) out.set(rx.subarray(0, rxLen), 0)
    out[req.inCap - 1] = ok ? TRANS_OK : TRANS_ERR
    req.reply(out)

    const loggedTx = copyLogBytes(txPayload.length > 0 ? txPayload : tx.subarray(0, len))
    const loggedRx = copyLogBytes(rxLen > 0 ? rx.subarray(0, rxLen) : rx.subarray(0, len))
    record({
      cs,
      tx: loggedTx.bytes,
      rx: loggedRx.bytes,
      byteLength: len,
      ok,
      chip: chip?.name ?? null,
      csChange,
    })
  }

  return {
    name,
    handle,

    attachConfig(config) {
      if (config.length >= 1 && config[0]! > 0) csMax = config[0]!
    },

    attachChip(chip) {
      if (bus.has(chip.cs)) {
        throw new Error(
          `spi: CS ${chip.cs} is already taken by ${bus.get(chip.cs)!.name}`,
        )
      }
      bus.set(chip.cs, chip)
      refreshChips()
      notify()
      return () => {
        if (bus.get(chip.cs) === chip) {
          bus.delete(chip.cs)
          refreshChips()
          notify()
        }
      }
    },

    detachChip(cs) {
      if (bus.delete(cs)) {
        refreshChips()
        notify()
      }
    },

    chips: () => chipsSnapshot,
    transactions() {
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
    csMaxNumber: () => csMax,

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
