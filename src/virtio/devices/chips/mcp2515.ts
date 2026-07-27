/**
 * Microchip MCP2515 — page-side SPI CAN controller model.
 *
 * Splits cleanly from {@link ../../../can/bus.ts}: this file speaks SPI and
 * owns registers, TX/RX buffers, acceptance filters and the INT line; the bus
 * owns the medium and the other nodes. The seam is a frame in and a frame out,
 * so a second controller would not force the network to be rewritten.
 *
 * Both command families are implemented, because which one Zephyr's
 * `drivers/can/can_mcp2515.c` reaches for is a detail we should not be
 * hostage to: the fast commands (LOAD_TX / RTS / READ_RX / READ_STATUS) and
 * plain READ / WRITE over the same flat register file. TX and RX buffers are
 * memory-mapped on real silicon, so both routes land on the same bytes.
 *
 * Compatible: `microchip,mcp2515`.
 */

import type { SpiChip, SpiTransferOpts } from '../spi'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { RegisterDecl } from '../registers/types'
import type { CanFrame } from '@/can/bus'
import mcp2515Map from './maps/mcp2515.json'

/* SPI commands. */
const CMD_RESET = 0xc0
const CMD_READ = 0x03
const CMD_WRITE = 0x02
const CMD_BIT_MODIFY = 0x05
const CMD_READ_STATUS = 0xa0
const CMD_RX_STATUS = 0xb0
/** 0x40 | abc — abc selects buffer and whether to start at SIDH or D0. */
const CMD_LOAD_TX = 0x40
/** 0x80 | mask — mask bits 0..2 request send on TXB0..2. */
const CMD_RTS = 0x80
/** 0x90 | nm — 0x90 = RXB0 SIDH, 0x94 = RXB1 SIDH. */
const CMD_READ_RX = 0x90

/* Registers. */
const REG_CANSTAT = 0x0e
const REG_CANCTRL = 0x0f
const REG_TEC = 0x1c
const REG_REC = 0x1d
const REG_CNF3 = 0x28
const REG_CNF2 = 0x29
const REG_CNF1 = 0x2a
const REG_CANINTE = 0x2b
const REG_CANINTF = 0x2c
const REG_EFLG = 0x2d

const TXB_BASE = [0x30, 0x40, 0x50] as const
const RXB_BASE = [0x60, 0x70] as const
const RXM_BASE = [0x20, 0x24] as const
/** RXF0-2 filter RXB0, RXF3-5 filter RXB1. */
const RXF_BASE = [0x00, 0x04, 0x08, 0x10, 0x14, 0x18] as const

const TXB_CTRL_TXREQ = 1 << 3
const RXB_CTRL_RXM_MASK = 0x60

const INTF_RX0 = 1 << 0
const INTF_RX1 = 1 << 1
const INTF_TX = [1 << 2, 1 << 3, 1 << 4] as const

const MODE_NORMAL = 0
const MODE_LOOPBACK = 2
const MODE_LISTEN_ONLY = 3
const MODE_CONFIG = 4

/** Datasheet reset value: config mode, CLKEN set, CLKPRE = /8. */
const CANCTRL_RESET = 0x87
const REGS = 128

const MCP2515_REGISTERS = registersFromJson(mcp2515Map as RegisterMapJson)

export interface Mcp2515Options {
  cs?: number
  name?: string
  /** Raised (active low) whenever an enabled interrupt flag is set. */
  onInt?: (asserted: boolean) => void
  /** Frame the controller wants to put on the bus. */
  onTransmit?: (frame: CanFrame) => void
}

export interface Mcp2515Hooks {
  onInt?: (asserted: boolean) => void
  onTransmit?: (frame: CanFrame) => void
}

export interface Mcp2515Chip extends SpiChip {
  readonly kind: 'can'
  /**
   * Wire the sideband after construction. The attach picker builds a bare
   * chip — `devices/` must not reach into host modules — and `hostCan.ts`
   * wires it when it sees one land on the bus.
   */
  setHooks(hooks: Mcp2515Hooks): void
  readonly registers: readonly RegisterDecl[]
  readBytes(addr: number, len: number): Uint8Array
  writeBytes(addr: number, bytes: Uint8Array): void
  /** Offer an inbound frame. Returns whether a filter accepted it. */
  deliver(frame: CanFrame): 'accepted' | 'filtered'
  mode(): number
  intAsserted(): boolean
  subscribe(fn: () => void): () => void
}

export function createMcp2515(opts: Mcp2515Options = {}): Mcp2515Chip {
  const cs = opts.cs ?? 0
  const hooks: Mcp2515Hooks = { onInt: opts.onInt, onTransmit: opts.onTransmit }
  const regs = new Uint8Array(REGS)
  const listeners = new Set<() => void>()
  let int = false

  function notify() {
    for (const fn of listeners) fn()
  }

  function reset() {
    regs.fill(0)
    regs[REG_CANCTRL] = CANCTRL_RESET
    // OPMOD mirrors REQOP; after reset that is configuration mode.
    regs[REG_CANSTAT] = MODE_CONFIG << 5
    setInt(false)
  }

  function setInt(next: boolean) {
    if (next === int) return
    int = next
    hooks.onInt?.(next)
  }

  /** INT is asserted while any enabled flag is set — level, not edge. */
  function refreshInt() {
    setInt((regs[REG_CANINTF]! & regs[REG_CANINTE]!) !== 0)
  }

  function mode(): number {
    return (regs[REG_CANSTAT]! >> 5) & 0x07
  }

  function writeReg(addr: number, value: number) {
    if (addr >= REGS) return
    regs[addr] = value & 0xff

    if (addr === REG_CANCTRL) {
      // The driver spins on CANSTAT.OPMOD reading back what it asked for.
      // Applying the request immediately is what keeps probe from hanging.
      regs[REG_CANSTAT] = (regs[REG_CANSTAT]! & 0x1f) | ((value & 0xe0) as number)
      notify()
      return
    }
    if (addr === REG_CANINTF || addr === REG_CANINTE) {
      refreshInt()
      notify()
      return
    }
    for (let n = 0; n < TXB_BASE.length; n++) {
      if (addr === TXB_BASE[n] && (value & TXB_CTRL_TXREQ) !== 0) {
        requestSend(n)
        return
      }
    }
    notify()
  }

  function readReg(addr: number): number {
    return addr < REGS ? regs[addr]! : 0
  }

  /** SIDH/SIDL/EID8/EID0 → id, per the datasheet's packing. */
  function decodeId(base: number): { id: number; ext: boolean } {
    const sidh = regs[base]!
    const sidl = regs[base + 1]!
    const ext = (sidl & 0x08) !== 0
    if (!ext) return { id: ((sidh << 3) | (sidl >> 5)) & 0x7ff, ext: false }
    const eid8 = regs[base + 2]!
    const eid0 = regs[base + 3]!
    const std = ((sidh << 3) | (sidl >> 5)) & 0x7ff
    const low = ((sidl & 0x03) << 16) | (eid8 << 8) | eid0
    return { id: ((std << 18) | low) >>> 0, ext: true }
  }

  function encodeId(base: number, id: number, ext: boolean) {
    if (!ext) {
      regs[base] = (id >> 3) & 0xff
      regs[base + 1] = (id << 5) & 0xe0
      regs[base + 2] = 0
      regs[base + 3] = 0
      return
    }
    const std = (id >>> 18) & 0x7ff
    regs[base] = (std >> 3) & 0xff
    regs[base + 1] = (((std << 5) & 0xe0) | 0x08 | ((id >>> 16) & 0x03)) & 0xff
    regs[base + 2] = (id >>> 8) & 0xff
    regs[base + 3] = id & 0xff
  }

  function requestSend(n: number) {
    const base = TXB_BASE[n]!
    const { id, ext } = decodeId(base + 1)
    const dlcReg = regs[base + 5]!
    const rtr = (dlcReg & 0x40) !== 0
    const dlc = Math.min(dlcReg & 0x0f, 8)
    const data = rtr ? new Uint8Array() : regs.slice(base + 6, base + 6 + dlc)

    // TXREQ clears when the frame goes out, and the matching flag latches.
    regs[base] = regs[base]! & ~TXB_CTRL_TXREQ
    regs[REG_CANINTF] = regs[REG_CANINTF]! | INTF_TX[n]!
    refreshInt()
    notify()

    // Listen-only must not put anything on the wire, ACK included; loopback
    // must not either, but should still land in a receive buffer.
    const m = mode()
    if (m === MODE_LISTEN_ONLY) return
    const frame: CanFrame = { id, ext, rtr, data }
    if (m === MODE_LOOPBACK) {
      deliver(frame)
      return
    }
    hooks.onTransmit?.(frame)
  }

  /**
   * Acceptance filtering. A zero mask means "every bit is don't care", which
   * is the hardware's accept-all default and what a driver that has not yet
   * programmed filters relies on.
   */
  function accepts(buffer: number, frame: CanFrame): boolean {
    const rxm = (regs[RXB_BASE[buffer]!]! & RXB_CTRL_RXM_MASK) >> 5
    if (rxm === 3) return true // masks off, take everything

    // Masks and filters share the SIDH/SIDL/EID8/EID0 layout of a buffer.
    const mask = decodeId(RXM_BASE[buffer]!)
    if (mask.id === 0) return true

    const filters = buffer === 0 ? [0, 1] : [2, 3, 4, 5]
    for (const f of filters) {
      const filter = decodeId(RXF_BASE[f]!)
      if (filter.ext !== frame.ext) continue
      if ((frame.id & mask.id) === (filter.id & mask.id)) return true
    }
    return false
  }

  function deliver(frame: CanFrame): 'accepted' | 'filtered' {
    if (mode() === MODE_CONFIG) return 'filtered'

    for (let n = 0; n < RXB_BASE.length; n++) {
      const flag = n === 0 ? INTF_RX0 : INTF_RX1
      // A full buffer the driver has not drained yet cannot take another.
      if ((regs[REG_CANINTF]! & flag) !== 0) continue
      if (!accepts(n, frame)) continue

      const base = RXB_BASE[n]!
      encodeId(base + 1, frame.id, frame.ext)
      regs[base + 5] = (frame.rtr ? 0x40 : 0) | (frame.rtr ? 0 : frame.data.length & 0x0f)
      for (let i = 0; i < 8; i++) regs[base + 6 + i] = frame.data[i] ?? 0
      regs[REG_CANINTF] = regs[REG_CANINTF]! | flag
      refreshInt()
      notify()
      return 'accepted'
    }
    return 'filtered'
  }

  /** READ STATUS: RX0IF, RX1IF, TXnREQ and TXnIF in one byte. */
  function statusByte(): number {
    const intf = regs[REG_CANINTF]!
    let out = 0
    if (intf & INTF_RX0) out |= 1 << 0
    if (intf & INTF_RX1) out |= 1 << 1
    if (regs[TXB_BASE[0]!]! & TXB_CTRL_TXREQ) out |= 1 << 2
    if (intf & INTF_TX[0]!) out |= 1 << 3
    if (regs[TXB_BASE[1]!]! & TXB_CTRL_TXREQ) out |= 1 << 4
    if (intf & INTF_TX[1]!) out |= 1 << 5
    if (regs[TXB_BASE[2]!]! & TXB_CTRL_TXREQ) out |= 1 << 6
    if (intf & INTF_TX[2]!) out |= 1 << 7
    return out
  }

  function rxStatusByte(): number {
    const intf = regs[REG_CANINTF]!
    let out = 0
    if (intf & INTF_RX0) out |= 1 << 6
    if (intf & INTF_RX1) out |= 1 << 7
    return out
  }

  return {
    cs,
    kind: 'can',
    name: opts.name ?? 'MCP2515 CAN',
    registers: MCP2515_REGISTERS,

    transfer(tx: Uint8Array, rx: Uint8Array, _opts: SpiTransferOpts) {
      rx.fill(0)
      if (tx.length === 0) return true
      const cmd = tx[0]!

      if (cmd === CMD_RESET) {
        reset()
        notify()
        return true
      }

      if (cmd === CMD_READ) {
        const addr = tx[1] ?? 0
        for (let i = 2; i < rx.length; i++) rx[i] = readReg(addr + (i - 2))
        return true
      }

      if (cmd === CMD_WRITE) {
        const addr = tx[1] ?? 0
        for (let i = 2; i < tx.length; i++) writeReg(addr + (i - 2), tx[i]!)
        return true
      }

      if (cmd === CMD_BIT_MODIFY) {
        const addr = tx[1] ?? 0
        const mask = tx[2] ?? 0
        const data = tx[3] ?? 0
        writeReg(addr, (readReg(addr) & ~mask) | (data & mask))
        return true
      }

      if (cmd === CMD_READ_STATUS) {
        for (let i = 1; i < rx.length; i++) rx[i] = statusByte()
        return true
      }

      if (cmd === CMD_RX_STATUS) {
        for (let i = 1; i < rx.length; i++) rx[i] = rxStatusByte()
        return true
      }

      if ((cmd & 0xf8) === CMD_LOAD_TX) {
        // abc: bit 0 selects D0 over SIDH, bits 2:1 select the buffer.
        const abc = cmd & 0x07
        const buffer = abc >> 1
        const base = TXB_BASE[Math.min(buffer, 2)]!
        const addr = (abc & 1) === 0 ? base + 1 : base + 6
        for (let i = 1; i < tx.length; i++) {
          const target = addr + (i - 1)
          if (target < REGS) regs[target] = tx[i]!
        }
        notify()
        return true
      }

      if ((cmd & 0xf8) === CMD_RTS) {
        const mask = cmd & 0x07
        for (let n = 0; n < 3; n++) {
          if ((mask & (1 << n)) === 0) continue
          regs[TXB_BASE[n]!] = regs[TXB_BASE[n]!]! | TXB_CTRL_TXREQ
          requestSend(n)
        }
        return true
      }

      if ((cmd & 0xf9) === CMD_READ_RX) {
        const nm = (cmd >> 1) & 0x03
        const buffer = nm >> 1
        const base = RXB_BASE[Math.min(buffer, 1)]!
        const addr = (nm & 1) === 0 ? base + 1 : base + 6
        for (let i = 1; i < rx.length; i++) rx[i] = readReg(addr + (i - 1))
        // Reading a buffer out clears its flag, exactly as the fast command
        // does on silicon — that is the point of using it over a plain READ.
        regs[REG_CANINTF] = regs[REG_CANINTF]! & ~(buffer === 0 ? INTF_RX0 : INTF_RX1)
        refreshInt()
        notify()
        return true
      }

      return true
    },

    readBytes(addr, len) {
      const out = new Uint8Array(len)
      for (let i = 0; i < len; i++) out[i] = readReg(addr + i)
      return out
    },

    writeBytes(addr, bytes) {
      for (let i = 0; i < bytes.length; i++) writeReg(addr + i, bytes[i]!)
    },

    setHooks(next) {
      hooks.onInt = next.onInt
      hooks.onTransmit = next.onTransmit
    },

    deliver,
    mode,
    intAsserted: () => int,

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export function isMcp2515(chip: SpiChip): chip is Mcp2515Chip {
  return (chip as Mcp2515Chip).kind === 'can'
}

/** Exposed for the register map and tests. */
export const MCP2515_REGS = {
  CANSTAT: REG_CANSTAT,
  CANCTRL: REG_CANCTRL,
  CANINTE: REG_CANINTE,
  CANINTF: REG_CANINTF,
  EFLG: REG_EFLG,
  TEC: REG_TEC,
  REC: REG_REC,
  CNF1: REG_CNF1,
  CNF2: REG_CNF2,
  CNF3: REG_CNF3,
  TXB0: TXB_BASE[0],
  RXB0: RXB_BASE[0],
  MODE_NORMAL,
  MODE_CONFIG,
  MODE_LISTEN_ONLY,
  MODE_LOOPBACK,
} as const
