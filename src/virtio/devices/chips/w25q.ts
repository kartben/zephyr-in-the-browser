/**
 * Minimal JEDEC SPI NOR flash stub (W25Q-class command set).
 *
 * Enough for Zephyr's `jedec,spi-nor` driver under
 * `CONFIG_SPI_NOR_SFDP_MINIMAL`: RDID, RDSR/WRSR, WREN/WRDI, READ, PP, and
 * sector/chip erase. SFDP is not modelled — the guest trusts the DT `size` /
 * `jedec-id`. Deep power-down (0xB9 / 0xAB) is accepted as a no-op so drivers
 * that enter DPD on idle do not TRANS_ERR.
 *
 * Capacity is 1 MiB so stock `samples/drivers/spi_flash` (test offset
 * `0xff000`) fits. Prefer no full-image localStorage persist at this size.
 */

import type { SpiChip, SpiTransferOpts } from '../spi'

/** Winbond-ish JEDEC ID — density 0x14 ⇒ 2^20 bytes = 1 MiB (W25Q80). */
export const W25Q_JEDEC_ID = Uint8Array.of(0xef, 0x40, 0x14)

/**
 * Default capacity — must cover `SPI_FLASH_TEST_REGION_OFFSET` (0xff000) plus
 * one 4 KiB sector from samples/drivers/spi_flash.
 */
export const W25Q_DEFAULT_SIZE = 1024 * 1024

const CMD_WREN = 0x06
const CMD_WRDI = 0x04
const CMD_RDSR = 0x05
const CMD_WRSR = 0x01
const CMD_READ = 0x03
const CMD_FAST_READ = 0x0b
const CMD_PP = 0x02
const CMD_SE = 0x20
const CMD_BE_32K = 0x52
const CMD_BE_64K = 0xd8
const CMD_CE = 0xc7
const CMD_CE_ALT = 0x60
const CMD_RDID = 0x9f
const CMD_DPD = 0xb9
const CMD_RDPD = 0xab

const SR_WIP = 0x01
const SR_WEL = 0x02

export interface SpiFlashDecl {
  name: string
  /** Zephyr flash device name for shell hints (`flash@0`). */
  shellLabel?: string
  defaultCs: number
  size: number
  pageSize: number
  sectorSize: number
  jedecId: Uint8Array
  erased?: number
}

export interface SpiFlashChip extends SpiChip {
  readonly decl: SpiFlashDecl
  readonly memory: Uint8Array
  version(): number
  pointer(): number
  poke(offset: number, value: number): void
  erase(): void
  subscribe(fn: () => void): () => void
}

export interface SpiFlashOptions {
  cs?: number
  name?: string
  size?: number
  jedecId?: Uint8Array
  persistKey?: string
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'rdid'; i: number }
  | { kind: 'rdsr' }
  | { kind: 'wrsr' }
  | { kind: 'addr'; cmd: number; addr: number; got: number }
  | { kind: 'dummy'; addr: number; left: number }
  | { kind: 'read'; addr: number }
  | { kind: 'program'; addr: number }
  | { kind: 'ignore' }

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

function loadPersisted(key: string, size: number): Uint8Array | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw || raw.length !== size * 2 || !/^[0-9a-fA-F]+$/.test(raw)) return null
    const out = new Uint8Array(size)
    for (let i = 0; i < size; i++) out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16)
    return out
  } catch {
    return null
  }
}

function savePersisted(key: string, bytes: Uint8Array) {
  try {
    localStorage.setItem(key, toHex(bytes))
  } catch {
    /* private mode / quota — keep going in RAM */
  }
}

export const w25qDecl: SpiFlashDecl = {
  name: 'W25Q80JV SPI NOR',
  shellLabel: 'flash@0',
  defaultCs: 0,
  size: W25Q_DEFAULT_SIZE,
  pageSize: 256,
  sectorSize: 4096,
  jedecId: W25Q_JEDEC_ID,
  erased: 0xff,
}

export function createW25q(options: SpiFlashOptions = {}): SpiFlashChip {
  const decl: SpiFlashDecl = {
    ...w25qDecl,
    defaultCs: options.cs ?? w25qDecl.defaultCs,
    name: options.name ?? w25qDecl.name,
    size: options.size ?? w25qDecl.size,
    jedecId: options.jedecId ? options.jedecId.slice() : w25qDecl.jedecId.slice(),
  }
  const erased = decl.erased ?? 0xff
  const memory =
    (options.persistKey ? loadPersisted(options.persistKey, decl.size) : null) ??
    new Uint8Array(decl.size).fill(erased)

  const listeners = new Set<() => void>()
  let version = 0
  let pointer = 0
  let status = 0
  let phase: Phase = { kind: 'idle' }

  const notify = (bump: boolean) => {
    if (bump) {
      version++
      if (options.persistKey) savePersisted(options.persistKey, memory)
    }
    for (const fn of listeners) fn()
  }

  const startCmd = (cmd: number) => {
    switch (cmd) {
      case CMD_WREN:
        status |= SR_WEL
        phase = { kind: 'ignore' }
        return
      case CMD_WRDI:
        status &= ~SR_WEL
        phase = { kind: 'ignore' }
        return
      case CMD_RDSR:
        phase = { kind: 'rdsr' }
        return
      case CMD_WRSR:
        phase = { kind: 'wrsr' }
        return
      case CMD_RDID:
        phase = { kind: 'rdid', i: 0 }
        return
      case CMD_READ:
      case CMD_FAST_READ:
      case CMD_PP:
      case CMD_SE:
      case CMD_BE_32K:
      case CMD_BE_64K:
        phase = { kind: 'addr', cmd, addr: 0, got: 0 }
        return
      case CMD_CE:
      case CMD_CE_ALT:
        if (status & SR_WEL) {
          memory.fill(erased)
          status &= ~SR_WEL
          notify(true)
        }
        phase = { kind: 'ignore' }
        return
      case CMD_DPD:
      case CMD_RDPD:
        phase = { kind: 'ignore' }
        return
      default:
        phase = { kind: 'ignore' }
    }
  }

  const eraseBlock = (addr: number, blockSize: number) => {
    if (!(status & SR_WEL)) return
    const base = addr - (addr % blockSize)
    for (let i = 0; i < blockSize && base + i < decl.size; i++) {
      memory[base + i] = erased
    }
    status &= ~SR_WEL
    pointer = base
    notify(true)
  }

  const clock = (txByte: number): number => {
    switch (phase.kind) {
      case 'idle':
        startCmd(txByte)
        return 0xff
      case 'ignore':
        return 0xff
      case 'rdid': {
        const b = decl.jedecId[phase.i] ?? 0xff
        phase = { kind: 'rdid', i: phase.i + 1 }
        return b
      }
      case 'rdsr':
        // WIP is never sticky here — programs/erases complete instantly.
        return status & ~SR_WIP
      case 'wrsr':
        // Only non-WEL/WIP bits are writable in this stub.
        status = (status & (SR_WEL | SR_WIP)) | (txByte & ~(SR_WEL | SR_WIP))
        phase = { kind: 'ignore' }
        return 0xff
      case 'addr': {
        const addr = ((phase.addr << 8) | txByte) >>> 0
        const got = phase.got + 1
        if (got < 3) {
          phase = { ...phase, addr, got }
          return 0xff
        }
        const a = addr % decl.size
        if (phase.cmd === CMD_READ) {
          phase = { kind: 'read', addr: a }
          return 0xff
        }
        if (phase.cmd === CMD_FAST_READ) {
          phase = { kind: 'dummy', addr: a, left: 1 }
          return 0xff
        }
        if (phase.cmd === CMD_PP) {
          phase = { kind: 'program', addr: a }
          return 0xff
        }
        if (phase.cmd === CMD_SE) {
          eraseBlock(a, decl.sectorSize)
          phase = { kind: 'ignore' }
          return 0xff
        }
        if (phase.cmd === CMD_BE_32K) {
          eraseBlock(a, 32 * 1024)
          phase = { kind: 'ignore' }
          return 0xff
        }
        if (phase.cmd === CMD_BE_64K) {
          eraseBlock(a, 64 * 1024)
          phase = { kind: 'ignore' }
          return 0xff
        }
        phase = { kind: 'ignore' }
        return 0xff
      }
      case 'dummy': {
        const left = phase.left - 1
        phase = left > 0 ? { kind: 'dummy', addr: phase.addr, left } : { kind: 'read', addr: phase.addr }
        return 0xff
      }
      case 'read': {
        const b = memory[phase.addr]!
        pointer = phase.addr
        phase = { kind: 'read', addr: (phase.addr + 1) % decl.size }
        return b
      }
      case 'program': {
        if (status & SR_WEL) {
          // Flash program can only clear bits.
          memory[phase.addr] = memory[phase.addr]! & txByte
          pointer = phase.addr
          const pageBase = phase.addr & ~(decl.pageSize - 1)
          const next = pageBase + ((phase.addr + 1) & (decl.pageSize - 1))
          phase = { kind: 'program', addr: next }
          notify(true)
        }
        return 0xff
      }
    }
  }

  const chip: SpiFlashChip = {
    cs: decl.defaultCs,
    name: decl.name,
    decl,
    memory,

    transfer(tx, rx, _opts: SpiTransferOpts) {
      for (let i = 0; i < tx.length; i++) {
        rx[i] = clock(tx[i]!)
      }
      return true
    },

    version: () => version,
    pointer: () => pointer,
    poke(offset, value) {
      memory[((offset % decl.size) + decl.size) % decl.size] = value & 0xff
      notify(true)
    },
    erase() {
      memory.fill(erased)
      status = 0
      phase = { kind: 'idle' }
      notify(true)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }

  // End of CS must reset the command state machine — wrap transfer.
  const inner = chip.transfer.bind(chip)
  chip.transfer = (tx, rx, opts) => {
    const ok = inner(tx, rx, opts)
    if (opts.csChange) {
      if (phase.kind === 'program') status &= ~SR_WEL
      phase = { kind: 'idle' }
    }
    return ok
  }

  return chip
}

export function isSpiFlashChip(chip: SpiChip): chip is SpiFlashChip {
  return (
    'decl' in chip &&
    'memory' in chip &&
    typeof (chip as SpiFlashChip).pointer === 'function' &&
    typeof (chip as SpiFlashChip).version === 'function' &&
    ArrayBuffer.isView((chip as SpiFlashChip).memory)
  )
}

/** Loopback — every TX byte comes back on RX. Useful for attach / traffic demos. */
export function createSpiLoopback(cs = 0, name = 'SPI loopback'): SpiChip {
  return {
    cs,
    name,
    transfer(tx, rx) {
      rx.set(tx)
      return true
    },
  }
}
