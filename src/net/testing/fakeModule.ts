/**
 * A JS stand-in for the patched QEMU's `browser` netdev exports, backed by a
 * plain Uint8Array "heap". The mock backend attaches this to hostNet so the
 * entire production path — ring codec, adaptive polling, stack, capture —
 * runs identically with zero QEMU assets. The `guestSide` handle is where a
 * FakeGuest plugs in as the other end of the rings.
 */

import { ringDrain, ringWrite } from '../ringCodec'

const RING_SIZE = 256 * 1024
const TX_BASE = 0
const RX_BASE = RING_SIZE

export interface FakeNetModule {
  /** Shaped like the Emscripten instance hostNet expects. */
  module: Record<string, unknown>
  guestSide: {
    /** Frames the page injected for the guest (drains the RX ring). */
    drainRx(): Uint8Array[]
    /** A frame the guest transmits (appends to the TX ring). */
    writeTx(frame: Uint8Array): void
    linkUp(): boolean
  }
}

export function createFakeNetModule(): FakeNetModule {
  const heap = new Uint8Array(2 * RING_SIZE)
  let txWr = 0
  let txRd = 0
  let rxWr = 0
  let rxRd = 0
  let link = 1

  const module = {
    HEAPU8: heap,
    _qemu_browser_net_ready: () => 1,
    _qemu_browser_net_ring_size: () => RING_SIZE,
    _qemu_browser_net_tx_ring: () => TX_BASE,
    _qemu_browser_net_tx_write_index: () => txWr,
    _qemu_browser_net_tx_read_index: () => txRd,
    _qemu_browser_net_tx_set_read_index: (v: number) => {
      txRd = v >>> 0
    },
    _qemu_browser_net_rx_ring: () => RX_BASE,
    _qemu_browser_net_rx_write_index: () => rxWr,
    _qemu_browser_net_rx_read_index: () => rxRd,
    _qemu_browser_net_rx_set_write_index: (v: number) => {
      rxWr = v >>> 0
    },
    _qemu_browser_net_set_link: (up: number) => {
      link = up
    },
  }

  return {
    module,
    guestSide: {
      drainRx() {
        const frames: Uint8Array[] = []
        rxRd = ringDrain(heap, RX_BASE, RING_SIZE, rxRd, rxWr, (f) => frames.push(f))
        return frames
      },
      writeTx(frame: Uint8Array) {
        const next = ringWrite(heap, TX_BASE, RING_SIZE, txWr, txRd, frame)
        if (next !== null) txWr = next
      },
      linkUp: () => link === 1,
    },
  }
}
