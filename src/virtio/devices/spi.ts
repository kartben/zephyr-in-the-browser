/**
 * The page's SPI bus, and the VIRTIO controller that is one way onto it.
 *
 * Same shape as the I²C adapter: one request queue on the generic browser
 * bridge, chips modelled in TypeScript and selected by chip-select id (`reg`
 * in the guest DT), no QEMU device of their own.
 *
 * And the same split, for the same reason. The **bus** is the chip registry,
 * the chip-select state, the traffic log and {@link SpiModel.transferMessage};
 * the **transport** is `handle` below. src/hostSpi.ts is the other transport:
 * the ESP32-C3 has no virtio bus, so its guest drives the SoC's own GP-SPI2
 * controller and QEMU hands each run to the same call.
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

/**
 * How long a chip select keeps reading as asserted after its last transfer.
 *
 * CS is a GPIO the controller drives low around a message, and a real assert is
 * microseconds wide — far too short to see. The model stretches it so the UI can
 * show the line at all: a single transfer lights CS for this long, a stream of
 * them holds it lit. A message that leaves CS asserted between transfers
 * (`cs_change` clear) is lit for as long as the guest actually holds it.
 */
const CS_LIT_MS = 180

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
  /**
   * One full-duplex run: shift `tx` out to whatever is on `cs`, take `rx`
   * back, light the chip select and log it. False when nothing is there or
   * the chip failed the transfer — SPI has no NAK, so the guest sees an error
   * rather than a quiet bus.
   *
   * `rx` is filled in place and must be the same length as `tx`.
   */
  transferMessage(cs: number, tx: Uint8Array, rx: Uint8Array, opts: SpiTransferOpts): boolean
  /** Whether a chip is on this chip select. */
  hasChip(cs: number): boolean
  attachChip(chip: SpiChip): () => void
  detachChip(cs: number): void
  chips(): SpiChip[]
  /**
   * True while this chip select reads as asserted — the guest is clocking the
   * chip, or held CS low, or did so within the last {@link CS_LIT_MS}.
   * Subscribers are notified on both edges.
   */
  csAsserted(cs: number): boolean
  transactions(): readonly SpiTransaction[]
  clearTransactions(): void
  subscribe(fn: () => void): () => void
  transactionCount(): number
  /** Config-space CS count, once the bridge has attached config. */
  csMaxNumber(): number
}

/** Live state of one chip-select line, as the UI reads it. */
interface CsLine {
  asserted: boolean
  /** Last transfer left CS low (`cs_change` clear), so it is genuinely held. */
  held: boolean
  litUntil: number
  timer?: ReturnType<typeof setTimeout>
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
  const csLines = new Map<number, CsLine>()

  const refreshChips = () => {
    chipsSnapshot = [...bus.values()].sort((a, b) => a.cs - b.cs)
  }

  const notify = () => {
    for (const fn of listeners) fn()
  }

  /** Drop a chip select back to idle once its lit window has run out. */
  const sweepCs = (cs: number) => {
    const line = csLines.get(cs)
    if (!line) return
    line.timer = undefined
    // Held low by the guest: nothing to sweep until a cs_change transfer.
    if (line.held) return
    const remaining = line.litUntil - performance.now()
    if (remaining > 0) {
      line.timer = setTimeout(() => sweepCs(cs), remaining)
      return
    }
    if (!line.asserted) return
    line.asserted = false
    notify()
  }

  /** CS went low for a transfer; `held` is `cs_change` clear — it stays low. */
  const assertCs = (cs: number, held: boolean) => {
    let line = csLines.get(cs)
    if (!line) {
      line = { asserted: false, held: false, litUntil: 0 }
      csLines.set(cs, line)
    }
    line.held = held
    line.litUntil = performance.now() + CS_LIT_MS
    if (!line.asserted) {
      // The rising edge is worth a render immediately; the fall rides the
      // sweep timer, so a busy bus costs one notify per lit window per line.
      line.asserted = true
      notify()
    }
    if (!held && line.timer === undefined) {
      line.timer = setTimeout(() => sweepCs(cs), CS_LIT_MS)
    }
  }

  /** Forget a line's state — the part on it is going away. */
  const forgetCs = (cs: number) => {
    const line = csLines.get(cs)
    if (!line) return
    if (line.timer !== undefined) clearTimeout(line.timer)
    csLines.delete(cs)
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

    const ok = transferMessage(cs, tx, rx, { csChange, bitsPerWord, mode, freq })

    const out = new Uint8Array(req.inCap)
    if (ok && rxLen > 0) out.set(rx.subarray(0, rxLen), 0)
    out[req.inCap - 1] = ok ? TRANS_OK : TRANS_ERR
    req.reply(out)
  }

  function transferMessage(
    cs: number,
    tx: Uint8Array,
    rx: Uint8Array,
    opts: SpiTransferOpts,
  ): boolean {
    const chip = bus.get(cs)
    const ok = chip ? chip.transfer(tx, rx, opts) !== false : false

    // The controller drove CS for this run whether or not anything answered on
    // it — an empty chip select still shows the guest trying.
    assertCs(cs, !opts.csChange)

    const loggedTx = copyLogBytes(tx)
    const loggedRx = copyLogBytes(rx)
    record({
      cs,
      tx: loggedTx.bytes,
      rx: loggedRx.bytes,
      byteLength: tx.length,
      ok,
      chip: chip?.name ?? null,
      csChange: opts.csChange,
    })
    return ok
  }

  return {
    name,
    handle,
    transferMessage,
    hasChip: (cs) => bus.has(cs),

    /** The guest reset: nothing holds a chip select any more, so all go dark. */
    reset() {
      let lit = false
      for (const [cs, line] of [...csLines]) {
        lit ||= line.asserted
        forgetCs(cs)
      }
      if (lit) notify()
    },

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
      forgetCs(chip.cs)
      refreshChips()
      notify()
      return () => {
        if (bus.get(chip.cs) === chip) {
          bus.delete(chip.cs)
          forgetCs(chip.cs)
          refreshChips()
          notify()
        }
      }
    },

    detachChip(cs) {
      if (bus.delete(cs)) {
        forgetCs(cs)
        refreshChips()
        notify()
      }
    },

    chips: () => chipsSnapshot,
    csAsserted: (cs) => csLines.get(cs)?.asserted === true,
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
