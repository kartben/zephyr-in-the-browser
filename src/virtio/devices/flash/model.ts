/**
 * Declarative JEDEC SPI NOR flash surface.
 *
 * Geometry + a W25Q-class command set is enough for Zephyr's
 * `jedec,spi-nor` under `CONFIG_SPI_NOR_SFDP_MINIMAL`. The first provider is
 * the W25Q stub; denser (or other vendor) parts are a new {@link SpiFlashDecl}
 * plus packaging — {@link SpiFlashBody} and the stats strip stay shared.
 *
 * Session counters ({@link FlashStats}) track what the guest actually did on
 * the bus — reads, programs, erases — plus occupancy and per-sector erase
 * wear so the card can show utilisation and a sector map without knowing
 * which silicon is behind the handle. When a `persistKey` is set, counters
 * and wear ride along with the sparse image in localStorage.
 */

import type { SpiChip, SpiTransferOpts } from '../spi'

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
  /** Capacity in bytes. */
  size: number
  /**
   * Page-program wrap size. A PP that runs past a page boundary wraps within
   * the page — real NOR behaviour, and what Zephyr's driver assumes.
   */
  pageSize: number
  /** Smallest erase unit (SE). Addresses are aligned down to this. */
  sectorSize: number
  /**
   * Optional larger erase sizes the command set accepts (BE 32K / 64K).
   * Omitted entries mean that opcode is ignored. Defaults: 32 KiB + 64 KiB.
   */
  blockEraseSizes?: readonly number[]
  jedecId: Uint8Array
  erased?: number
  /**
   * Rated erase cycles per sector (datasheet endurance). The card scales the
   * wear heatmap against this when set; omit for a relative (max-in-session)
   * scale only.
   */
  enduranceCycles?: number
}

/**
 * Guest-facing SPI activity plus derived occupancy. Op counters and wear are
 * persisted with the image when {@link SpiFlashOptions.persistKey} is set;
 * occupancy always reflects the live image.
 */
export interface FlashStats {
  readOps: number
  readBytes: number
  programOps: number
  programBytes: number
  sectorErases: number
  blockErases32k: number
  blockErases64k: number
  chipErases: number
  /** Non-erased byte count. */
  usedBytes: number
  /** Sectors with at least one non-erased byte. */
  dirtySectors: number
  sectorCount: number
  /**
   * Per-sector erase counts (wear). Index i covers
   * `[i * sectorSize, (i+1) * sectorSize)`.
   */
  sectorEraseCounts: Uint32Array
  /** Non-erased bytes per sector — occupancy for the sector map. */
  sectorUsedBytes: Uint32Array
  /** Max value in {@link sectorEraseCounts} (for heatmap scaling). */
  maxSectorErases: number
}

/** Counters + wear written beside sparse sectors in localStorage. */
interface PersistedFlashStats {
  readOps: number
  readBytes: number
  programOps: number
  programBytes: number
  sectorErases: number
  blockErases32k: number
  blockErases64k: number
  chipErases: number
  /** Per-sector erase counts; length must match sectorCount. */
  sectorEraseCounts: number[]
}

export interface SpiFlashChip extends SpiChip {
  readonly decl: SpiFlashDecl
  readonly memory: Uint8Array
  version(): number
  pointer(): number
  poke(offset: number, value: number): void
  erase(): void
  /** Live op counters + occupancy + wear for the flash card. */
  stats(): FlashStats
  /** Clear op counters and wear (and their persisted copy); keeps the image. */
  resetStats(): void
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
  | { kind: 'program'; addr: number; wrote: boolean }
  | { kind: 'ignore' }

const PERSIST_VERSION = 1
const PERSIST_DEBOUNCE_MS = 250

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

function fromHex(hex: string, into: Uint8Array): boolean {
  if (hex.length !== into.length * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return false
  for (let i = 0; i < into.length; i++) into[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return true
}

function sectorAllErased(bytes: Uint8Array, erased: number): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== erased) return false
  return true
}

function parsePersistedStats(
  raw: unknown,
  sectorCount: number,
): PersistedFlashStats | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v >>> 0 : 0)
  const counts = Array.isArray(s.sectorEraseCounts)
    ? s.sectorEraseCounts.map((n) => num(n))
    : []
  while (counts.length < sectorCount) counts.push(0)
  if (counts.length > sectorCount) counts.length = sectorCount
  return {
    readOps: num(s.readOps),
    readBytes: num(s.readBytes),
    programOps: num(s.programOps),
    programBytes: num(s.programBytes),
    sectorErases: num(s.sectorErases),
    blockErases32k: num(s.blockErases32k),
    blockErases64k: num(s.blockErases64k),
    chipErases: num(s.chipErases),
    sectorEraseCounts: counts,
  }
}

function statsAreZero(stats: PersistedFlashStats): boolean {
  if (
    stats.readOps ||
    stats.readBytes ||
    stats.programOps ||
    stats.programBytes ||
    stats.sectorErases ||
    stats.blockErases32k ||
    stats.blockErases64k ||
    stats.chipErases
  ) {
    return false
  }
  for (let i = 0; i < stats.sectorEraseCounts.length; i++) {
    if (stats.sectorEraseCounts[i]) return false
  }
  return true
}

function loadPersisted(
  key: string,
  size: number,
  sectorSize: number,
  erased: number,
): { memory: Uint8Array; stats: PersistedFlashStats | null } | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const sectorCount = Math.ceil(size / sectorSize)

    // Legacy full-image hex (only practical for tiny stubs).
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === size * 2) {
      const out = new Uint8Array(size)
      return fromHex(raw, out) ? { memory: out, stats: null } : null
    }

    const parsed = JSON.parse(raw) as {
      v?: number
      size?: number
      sectorSize?: number
      sectors?: Record<string, string>
      stats?: unknown
    }
    if (
      parsed.v !== PERSIST_VERSION ||
      parsed.size !== size ||
      parsed.sectorSize !== sectorSize ||
      !parsed.sectors ||
      typeof parsed.sectors !== 'object'
    ) {
      return null
    }
    const out = new Uint8Array(size).fill(erased)
    const sector = new Uint8Array(sectorSize)
    for (const [index, hex] of Object.entries(parsed.sectors)) {
      const si = Number(index)
      if (!Number.isInteger(si) || si < 0 || si * sectorSize >= size) continue
      if (!fromHex(hex, sector)) continue
      out.set(sector, si * sectorSize)
    }
    return { memory: out, stats: parsePersistedStats(parsed.stats, sectorCount) }
  } catch {
    return null
  }
}

function savePersistedSparse(
  key: string,
  bytes: Uint8Array,
  sectorSize: number,
  erased: number,
  stats: PersistedFlashStats,
) {
  try {
    const sectors: Record<string, string> = {}
    for (let off = 0, si = 0; off < bytes.length; off += sectorSize, si++) {
      const slice = bytes.subarray(off, Math.min(off + sectorSize, bytes.length))
      if (sectorAllErased(slice, erased)) continue
      sectors[String(si)] = toHex(slice)
    }
    if (Object.keys(sectors).length === 0 && statsAreZero(stats)) {
      localStorage.removeItem(key)
      return
    }
    localStorage.setItem(
      key,
      JSON.stringify({
        v: PERSIST_VERSION,
        size: bytes.length,
        sectorSize,
        sectors,
        stats,
      }),
    )
  } catch {
    /* private mode / quota — keep going in RAM */
  }
}

function countSectorUsed(memory: Uint8Array, base: number, len: number, erased: number): number {
  let n = 0
  for (let i = 0; i < len; i++) if (memory[base + i] !== erased) n++
  return n
}

/** Build a live {@link SpiFlashChip} from a declaration. */
export function createSpiFlashChip(baseDecl: SpiFlashDecl, options: SpiFlashOptions = {}): SpiFlashChip {
  const decl: SpiFlashDecl = {
    ...baseDecl,
    defaultCs: options.cs ?? baseDecl.defaultCs,
    name: options.name ?? baseDecl.name,
    size: options.size ?? baseDecl.size,
    jedecId: options.jedecId ? options.jedecId.slice() : baseDecl.jedecId.slice(),
  }
  const erased = decl.erased ?? 0xff
  const blockEraseSizes = decl.blockEraseSizes ?? [32 * 1024, 64 * 1024]
  const block32k = blockEraseSizes.find((n) => n === 32 * 1024)
  const block64k = blockEraseSizes.find((n) => n === 64 * 1024)
  const loaded = options.persistKey
    ? loadPersisted(options.persistKey, decl.size, decl.sectorSize, erased)
    : null
  const memory = loaded?.memory ?? new Uint8Array(decl.size).fill(erased)

  const sectorCount = Math.ceil(decl.size / decl.sectorSize)
  const sectorUsedBytes = new Uint32Array(sectorCount)
  const sectorEraseCounts = new Uint32Array(sectorCount)
  let usedBytes = 0
  for (let si = 0; si < sectorCount; si++) {
    const base = si * decl.sectorSize
    const len = Math.min(decl.sectorSize, decl.size - base)
    const n = countSectorUsed(memory, base, len, erased)
    sectorUsedBytes[si] = n
    usedBytes += n
  }

  const savedStats = loaded?.stats
  let readOps = savedStats?.readOps ?? 0
  let readBytes = savedStats?.readBytes ?? 0
  let programOps = savedStats?.programOps ?? 0
  let programBytes = savedStats?.programBytes ?? 0
  let sectorErases = savedStats?.sectorErases ?? 0
  let blockErases32k = savedStats?.blockErases32k ?? 0
  let blockErases64k = savedStats?.blockErases64k ?? 0
  let chipErases = savedStats?.chipErases ?? 0
  let maxSectorErases = 0
  if (savedStats) {
    for (let si = 0; si < sectorCount; si++) {
      const n = savedStats.sectorEraseCounts[si] ?? 0
      sectorEraseCounts[si] = n
      if (n > maxSectorErases) maxSectorErases = n
    }
  }
  let statsTouched = false

  const listeners = new Set<() => void>()
  let version = 0
  let pointer = 0
  let status = 0
  let phase: Phase = { kind: 'idle' }
  let persistTimer: ReturnType<typeof setTimeout> | undefined

  const snapshotPersistedStats = (): PersistedFlashStats => ({
    readOps,
    readBytes,
    programOps,
    programBytes,
    sectorErases,
    blockErases32k,
    blockErases64k,
    chipErases,
    sectorEraseCounts: Array.from(sectorEraseCounts),
  })

  const flushPersist = () => {
    persistTimer = undefined
    if (options.persistKey) {
      savePersistedSparse(
        options.persistKey,
        memory,
        decl.sectorSize,
        erased,
        snapshotPersistedStats(),
      )
    }
  }

  const schedulePersist = () => {
    if (!options.persistKey) return
    if (persistTimer !== undefined) clearTimeout(persistTimer)
    persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS)
  }

  const notify = (bump: boolean, persist = bump) => {
    if (bump) version++
    if (persist) schedulePersist()
    for (const fn of listeners) fn()
  }

  const markStats = () => {
    statsTouched = true
  }

  const noteSectorErase = (si: number) => {
    const next = (sectorEraseCounts[si]! + 1) >>> 0
    sectorEraseCounts[si] = next
    if (next > maxSectorErases) maxSectorErases = next
  }

  const clearSectorOccupancy = (si: number) => {
    usedBytes -= sectorUsedBytes[si]!
    sectorUsedBytes[si] = 0
  }

  const programByte = (addr: number, txByte: number) => {
    const prev = memory[addr]!
    const next = prev & txByte
    memory[addr] = next
    if (prev === erased && next !== erased) {
      const si = Math.floor(addr / decl.sectorSize)
      sectorUsedBytes[si]!++
      usedBytes++
    }
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
          for (let si = 0; si < sectorCount; si++) {
            clearSectorOccupancy(si)
            noteSectorErase(si)
          }
          usedBytes = 0
          chipErases++
          status &= ~SR_WEL
          markStats()
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

  const eraseBlock = (addr: number, blockSize: number, kind: 'sector' | '32k' | '64k') => {
    if (!(status & SR_WEL)) return
    const base = addr - (addr % blockSize)
    const end = Math.min(base + blockSize, decl.size)
    for (let off = base; off < end; off += decl.sectorSize) {
      const si = Math.floor(off / decl.sectorSize)
      const sectorBase = si * decl.sectorSize
      const len = Math.min(decl.sectorSize, decl.size - sectorBase)
      memory.fill(erased, sectorBase, sectorBase + len)
      clearSectorOccupancy(si)
      noteSectorErase(si)
    }
    if (kind === 'sector') sectorErases++
    else if (kind === '32k') blockErases32k++
    else blockErases64k++
    status &= ~SR_WEL
    pointer = base
    markStats()
    notify(true)
  }

  const enterRead = (addr: number) => {
    phase = { kind: 'read', addr }
    readOps++
    markStats()
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
          enterRead(a)
          return 0xff
        }
        if (phase.cmd === CMD_FAST_READ) {
          phase = { kind: 'dummy', addr: a, left: 1 }
          return 0xff
        }
        if (phase.cmd === CMD_PP) {
          phase = { kind: 'program', addr: a, wrote: false }
          return 0xff
        }
        if (phase.cmd === CMD_SE) {
          eraseBlock(a, decl.sectorSize, 'sector')
          phase = { kind: 'ignore' }
          return 0xff
        }
        if (phase.cmd === CMD_BE_32K && block32k) {
          eraseBlock(a, block32k, '32k')
          phase = { kind: 'ignore' }
          return 0xff
        }
        if (phase.cmd === CMD_BE_64K && block64k) {
          eraseBlock(a, block64k, '64k')
          phase = { kind: 'ignore' }
          return 0xff
        }
        phase = { kind: 'ignore' }
        return 0xff
      }
      case 'dummy': {
        const left = phase.left - 1
        if (left > 0) {
          phase = { kind: 'dummy', addr: phase.addr, left }
        } else {
          enterRead(phase.addr)
        }
        return 0xff
      }
      case 'read': {
        const b = memory[phase.addr]!
        pointer = phase.addr
        phase = { kind: 'read', addr: (phase.addr + 1) % decl.size }
        readBytes++
        markStats()
        return b
      }
      case 'program': {
        if (status & SR_WEL) {
          programByte(phase.addr, txByte)
          pointer = phase.addr
          programBytes++
          const wrote = true
          if (!phase.wrote) programOps++
          const pageBase = phase.addr & ~(decl.pageSize - 1)
          const next = pageBase + ((phase.addr + 1) & (decl.pageSize - 1))
          phase = { kind: 'program', addr: next, wrote }
          markStats()
          notify(true)
        }
        return 0xff
      }
    }
  }

  const dirtySectors = () => {
    let n = 0
    for (let i = 0; i < sectorCount; i++) if (sectorUsedBytes[i]! > 0) n++
    return n
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
      const addr = ((offset % decl.size) + decl.size) % decl.size
      const next = value & 0xff
      const prev = memory[addr]!
      if (prev === next) return
      memory[addr] = next
      if (prev === erased && next !== erased) {
        const si = Math.floor(addr / decl.sectorSize)
        sectorUsedBytes[si]!++
        usedBytes++
      } else if (prev !== erased && next === erased) {
        const si = Math.floor(addr / decl.sectorSize)
        sectorUsedBytes[si]!--
        usedBytes--
      }
      notify(true)
    },
    erase() {
      memory.fill(erased)
      usedBytes = 0
      sectorUsedBytes.fill(0)
      status = 0
      phase = { kind: 'idle' }
      if (persistTimer !== undefined) {
        clearTimeout(persistTimer)
        persistTimer = undefined
      }
      if (options.persistKey) {
        try {
          localStorage.removeItem(options.persistKey)
        } catch {
          /* ignore */
        }
      }
      // Bump for UI; do not schedulePersist — the key was just wiped.
      notify(true, false)
    },
    stats(): FlashStats {
      return {
        readOps,
        readBytes,
        programOps,
        programBytes,
        sectorErases,
        blockErases32k,
        blockErases64k,
        chipErases,
        usedBytes,
        dirtySectors: dirtySectors(),
        sectorCount,
        sectorEraseCounts,
        sectorUsedBytes,
        maxSectorErases,
      }
    },
    resetStats() {
      readOps = 0
      readBytes = 0
      programOps = 0
      programBytes = 0
      sectorErases = 0
      blockErases32k = 0
      blockErases64k = 0
      chipErases = 0
      sectorEraseCounts.fill(0)
      maxSectorErases = 0
      markStats()
      notify(false, true)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }

  // End of CS must reset the command state machine — wrap transfer.
  const inner = chip.transfer.bind(chip)
  chip.transfer = (tx, rx, opts) => {
    statsTouched = false
    const versionBefore = version
    const ok = inner(tx, rx, opts)
    if (opts.csChange) {
      if (phase.kind === 'program') status &= ~SR_WEL
      phase = { kind: 'idle' }
    }
    // Reads move the pointer / bump counters without a content version bump —
    // coalesce one UI tick per transfer so bulk reads do not fan out. Persist
    // counters too (debounced) so rd/wr/er tallies survive reload.
    if (statsTouched && version === versionBefore) notify(false, true)
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
    typeof (chip as SpiFlashChip).stats === 'function' &&
    ArrayBuffer.isView((chip as SpiFlashChip).memory)
  )
}

/** Compact byte counts for badges and the stats strip (`1.2K`, `1.0M`). */
export function formatFlashCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  return `${Math.round(n / 1_000_000)}M`
}

/** Human capacity label keyed off decl.size (`256 B`, `1.0 MiB`). */
export function formatFlashSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) {
    const kib = bytes / 1024
    return Number.isInteger(kib) ? `${kib} KiB` : `${kib.toFixed(1)} KiB`
  }
  const mib = bytes / (1024 * 1024)
  return Number.isInteger(mib) ? `${mib} MiB` : `${mib.toFixed(1)} MiB`
}

export function flashUsedFraction(stats: FlashStats, size: number): number {
  if (size <= 0) return 0
  return Math.min(1, Math.max(0, stats.usedBytes / size))
}

export function flashTotalErases(stats: FlashStats): number {
  return (
    stats.sectorErases +
    stats.blockErases32k +
    stats.blockErases64k +
    stats.chipErases
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
