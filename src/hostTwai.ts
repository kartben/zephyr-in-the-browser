/**
 * Browser end of the ESP32-C3's CAN controller.
 *
 * The third bridge on this board, and the one with no chip in the middle. I2C
 * and SPI reach page-side *models* of parts that would be soldered next to the
 * SoC; TWAI is the SoC's own CAN peripheral, modelled in QEMU on top of its
 * SJA1000 core (`hw/net/can/esp32c3_twai.c`), and what the browser supplies is
 * the other end of the wire: the bus itself, its nodes, arbitration and error
 * counters, all of which already live in src/can/bus.ts.
 *
 * So this module is a transport, not a device. It puts the guest's controller
 * on that bus as the local node, the same seat src/hostCan.ts gives the
 * MCP2515 on the virtio boards, and the two are mutually exclusive by
 * construction: a build has either a chip on SPI or the SoC's own controller,
 * never both.
 *
 * Shape is a ring pair rather than the request/response mailbox the other two
 * bridges use, because CAN traffic is not something the guest asks for. A
 * frame arrives because another node decided to send one, possibly while the
 * guest is idle, so neither side can be the one that waits.
 */

import { HOST_POLL_MS, register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'
import { canBus, LOCAL_NODE } from '@/hostCan'
import type { CanFrame, CanReceipt } from '@/can/bus'

/** Matches CanBrowserSlot in net/can/can_browser.c. */
const SLOT_BYTES = 16
const SLOT = { canId: 0, dlc: 4, flags: 5, data: 8 } as const

/** QEMU_CAN_* flags, in the top bits of can_id. */
const EFF_FLAG = 0x80000000
const RTR_FLAG = 0x40000000
const SFF_MASK = 0x000007ff
const EFF_MASK = 0x1fffffff

/**
 * How often the page drains what the guest transmitted. CAN is a low-rate bus
 * and the shared 100 ms beat would be visible as latency in the trace, so this
 * keeps its own timer, the same reasoning as the netdev's 10 ms poll.
 */
const POLL_MS = 10

const POLL_ID = 'host-twai'

interface TwaiExports {
  _qemu_can_browser_ready?: () => number
  _qemu_can_browser_ring_slots?: () => number
  _qemu_can_browser_tx_ring?: () => number
  _qemu_can_browser_rx_ring?: () => number
  _qemu_can_browser_tx_write_index?: () => number
  _qemu_can_browser_tx_read_index?: () => number
  _qemu_can_browser_tx_set_read_index?: (v: number) => void
  _qemu_can_browser_rx_write_index?: () => number
  _qemu_can_browser_rx_read_index?: () => number
  _qemu_can_browser_rx_set_write_index?: (v: number) => void
  HEAPU8?: Uint8Array
}

interface Bound {
  mod: TwaiExports
  slots: number
  tx: DataView
  rx: DataView
}

let bound: Bound | null = null
let mod: TwaiExports | null = null
let timer: ReturnType<typeof setInterval> | undefined
let detachNode: (() => void) | undefined
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

/** One slot out of a ring, as the bus models frames. */
function readSlot(view: DataView, index: number): CanFrame {
  const at = index * SLOT_BYTES
  const raw = view.getUint32(at + SLOT.canId, true)
  const ext = (raw & EFF_FLAG) !== 0
  const rtr = (raw & RTR_FLAG) !== 0
  // An RTR frame carries no data, and the bus takes its DLC from data.length.
  const dlc = rtr ? 0 : Math.min(view.getUint8(at + SLOT.dlc), 8)
  const data = new Uint8Array(dlc)
  for (let i = 0; i < dlc; i++) data[i] = view.getUint8(at + SLOT.data + i)
  return { id: raw & (ext ? EFF_MASK : SFF_MASK), ext, rtr, data }
}

function writeSlot(view: DataView, index: number, frame: CanFrame) {
  const at = index * SLOT_BYTES
  const dlc = Math.min(frame.data.length, 8)
  let raw = frame.id & (frame.ext ? EFF_MASK : SFF_MASK)
  if (frame.ext) raw |= EFF_FLAG
  if (frame.rtr) raw |= RTR_FLAG
  view.setUint32(at + SLOT.canId, raw >>> 0, true)
  view.setUint8(at + SLOT.dlc, dlc)
  view.setUint8(at + SLOT.flags, 0)
  view.setUint8(at + SLOT.flags + 1, 0)
  view.setUint8(at + SLOT.flags + 2, 0)
  for (let i = 0; i < 8; i++) {
    view.setUint8(at + SLOT.data + i, i < dlc ? frame.data[i]! : 0)
  }
}

/** Hand a frame the bus delivered to the guest's controller. */
function toGuest(frame: CanFrame): CanReceipt {
  const b = bound
  if (!b) return 'filtered'
  const wr = b.mod._qemu_can_browser_rx_write_index!()
  const rd = b.mod._qemu_can_browser_rx_read_index!()
  if (wr - rd >= b.slots) {
    // The guest is not keeping up: the ring is the receive FIFO, and this is
    // what a controller reports when it overruns.
    return 'overflow'
  }
  writeSlot(b.rx, wr % b.slots, frame)
  b.mod._qemu_can_browser_rx_set_write_index!((wr + 1) >>> 0)
  return 'accepted'
}

/** Drain what the guest transmitted onto the page's bus. */
function pollTx() {
  const b = bound
  if (!b) return
  let rd = b.mod._qemu_can_browser_tx_read_index!()
  const wr = b.mod._qemu_can_browser_tx_write_index!()
  const bus = canBus()

  while (rd !== wr) {
    bus.send(LOCAL_NODE, readSlot(b.tx, rd % b.slots))
    rd = (rd + 1) >>> 0
    b.mod._qemu_can_browser_tx_set_read_index!(rd)
  }
}

/** Look for the rings until the machine has realized the bridge. */
function discover() {
  if (bound) return
  const m = mod
  if (!m?._qemu_can_browser_ready?.() || !m.HEAPU8) return

  const slots = m._qemu_can_browser_ring_slots!()
  const txBase = m._qemu_can_browser_tx_ring!()
  const rxBase = m._qemu_can_browser_rx_ring!()
  if (!slots || !txBase || !rxBase) return

  bound = {
    mod: m,
    slots,
    tx: new DataView(m.HEAPU8.buffer, txBase, slots * SLOT_BYTES),
    rx: new DataView(m.HEAPU8.buffer, rxBase, slots * SLOT_BYTES),
  }

  const bus = canBus()
  detachNode = bus.attach({
    id: LOCAL_NODE,
    name: LOCAL_NODE,
    local: true,
    // Acceptance filtering happens inside the guest's controller, past this
    // point, so the trace can only report that the frame was handed over.
    receive: toGuest,
  })
  bus.start()

  unregisterPoll(POLL_ID)
  timer = setInterval(pollTx, POLL_MS)
  notify()
}

/**
 * Called by the qemu backend once its module is live. A build or a machine
 * without the CAN bridge simply never discovers the rings.
 */
export function attach(instance: unknown) {
  detach()
  mod = instance as TwaiExports | null
  registerPoll(POLL_ID, HOST_POLL_MS, discover)
  discover()
}

export function detach() {
  unregisterPoll(POLL_ID)
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
  const wasBound = bound !== null
  if (wasBound) {
    detachNode?.()
    canBus().stop()
  }
  detachNode = undefined
  bound = null
  mod = null
  if (wasBound) notify()
}

/** Whether the guest's own CAN controller is on the page's bus. */
export function available(): boolean {
  return bound !== null
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
