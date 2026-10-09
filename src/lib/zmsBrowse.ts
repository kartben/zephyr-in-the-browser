/**
 * Read a ZMS (Zephyr Memory Storage) store out of flash bytes.
 *
 * ZMS is a log: each sector fills with data from its start and with 16-byte
 * allocation table entries (ATEs) from its end, and a rewrite appends rather
 * than overwriting, so every older version stays on flash until garbage
 * collection erases its sector. The reader mirrors zms_init() and
 * zms_find_ate_with_id() in subsys/kvss/zms/zms.c:
 *
 * - The last ATE slot of every sector the store has opened is an "empty" ATE:
 *   id all ones, len 0xffff, and a metadata word carrying the magic 0x42, the
 *   format version and the ATE format (32- or 64-bit ids). That marker, with a
 *   valid CRC8, is how a partition is recognised as ZMS at all.
 * - The slot before it is the "close" ATE, written when the sector filled up.
 * - The open sector is the one after the first closed sector that is followed
 *   by a sector that is not closed. Newest to oldest is open, open - 1, ...,
 *   wrapping, and within a sector the ATE at the lowest address is the newest.
 * - An ATE counts only if its CRC8 holds and its cycle count matches the empty
 *   ATE of its sector.
 *
 * On top, `settings` decodes the settings subsystem's layout on ZMS
 * (subsys/settings/src/settings_zms.c): a key's name string is stored under a
 * hashed id with bit 31 set, its value at that id + 0x40000000, and a linked
 * list of keys at id | 1, headed at 0x80000000. Names are stored in clear, so
 * no hash has to be recomputed to show them.
 */

/** One version of an id, as found in one ATE. */
export interface ZmsVersion {
  /** Absolute address of the ATE in the image. */
  ateAddress: number
  sector: number
  /** 0 for the newest write anywhere in the store, growing with age. */
  age: number
  /** A delete: an ATE with len 0. */
  deleted: boolean
  len: number
  /** Where the bytes sit; null when they live inside the ATE (or a delete). */
  dataAddress: number | null
  bytes: Uint8Array
  /** CRC32 of the data when the build stored one (CONFIG_ZMS_DATA_CRC). */
  crcOk: boolean | null
}

export interface ZmsEntry {
  id: bigint
  idHex: string
  /** Newest first. */
  versions: ZmsVersion[]
  /** The version a read returns; null when the newest is a delete. */
  live: ZmsVersion | null
}

export type ZmsSectorState = 'open' | 'closed' | 'spare' | 'erased' | 'foreign'

export interface ZmsSector {
  index: number
  address: number
  state: ZmsSectorState
  /** From the empty ATE; null when the sector has none. */
  cycle: number | null
  /** Valid ATEs, markers included. */
  ates: number
  /** Bytes from the sector start to the end of the last data written. */
  dataBytes: number
  /** Bytes from the lowest used ATE slot to the sector end, header included. */
  ateBytes: number
  /** Whether this sector holds the gc_done marker of a finished collection. */
  gcDone: boolean
}

export interface ZmsSettingsKey {
  name: string
  nameId: number
  valueId: number
  /** Newest first; empty when the value was never found on flash. */
  versions: ZmsVersion[]
  live: ZmsVersion | null
}

export type ZmsIdRole =
  | { kind: 'name'; key: string }
  | { kind: 'value'; key: string }
  | { kind: 'list'; key: string }
  | { kind: 'head' }

export interface ZmsVolume {
  /** Absolute start of the store in the image. */
  offset: number
  sectorSize: number
  sectorCount: number
  ateSize: number
  idBits: 32 | 64
  version: number
  openSector: number
  sectors: ZmsSector[]
  /** Every id seen, newest write first. */
  entries: ZmsEntry[]
  /** The settings view, when the ids follow settings_zms's layout. */
  settings: { keys: ZmsSettingsKey[]; roles: Map<bigint, ZmsIdRole> } | null
}

export interface ZmsRegion {
  offset: number
  size: number
}

const MAGIC = 0x42
const SETTINGS_LL_HEAD = 0x80000000
const SETTINGS_DATA_OFFSET = 0x40000000

/** crc8_ccitt from lib/crc: poly 0x07, MSB first, no final xor. */
export function crc8Ccitt(seed: number, bytes: Uint8Array): number {
  let crc = seed & 0xff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}

let crc32Table: Uint32Array | null = null

/** crc32_ieee from lib/crc. */
export function crc32Ieee(bytes: Uint8Array): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crc32Table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of bytes) crc = crc32Table[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Ate {
  crcOk: boolean
  cycle: number
  len: number
  id: bigint
  /** Data offset within the sector (or full cycle count, for an empty ATE). */
  offset: number
  metadata: number
  dataCrc: number
  raw: Uint8Array
}

interface Format {
  idBits: 32 | 64
  /** Largest value ZMS keeps inside the ATE itself. */
  inlineMax: number
  inlineAt: number
}

const FORMAT_32: Format = { idBits: 32, inlineMax: 8, inlineAt: 8 }
const FORMAT_64: Format = { idBits: 64, inlineMax: 4, inlineAt: 12 }

function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8)
}

function u32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
}

function readAte(image: Uint8Array, at: number, fmt: Format): Ate | null {
  if (at < 0 || at + 16 > image.length) return null
  const raw = image.subarray(at, at + 16)
  const id = fmt.idBits === 32 ? BigInt(u32(raw, 4)) : (BigInt(u32(raw, 8)) << 32n) | BigInt(u32(raw, 4))
  return {
    crcOk: crc8Ccitt(0xff, raw.subarray(1)) === raw[0],
    cycle: raw[1]!,
    len: u16(raw, 2),
    id,
    // The 64-bit format has no room for both: offset and metadata share bytes 12-15.
    offset: fmt.idBits === 32 ? u32(raw, 8) : u32(raw, 12),
    metadata: u32(raw, 12),
    dataCrc: fmt.idBits === 32 ? u32(raw, 12) : 0,
    raw,
  }
}

function headId(fmt: Format): bigint {
  return fmt.idBits === 32 ? 0xffffffffn : 0xffffffffffffffffn
}

/** The format an empty ATE at `at` announces, or null if there is none. */
function emptyAteFormat(image: Uint8Array, at: number): Format | null {
  if (at < 0 || at + 16 > image.length) return null
  const metadata = u32(image, at + 12)
  if (((metadata >>> 8) & 0xff) !== MAGIC) return null
  const fmt = ((metadata >>> 16) & 0xf) === 1 ? FORMAT_64 : FORMAT_32
  const ate = readAte(image, at, fmt)
  if (!ate || !ate.crcOk || ate.len !== 0xffff || ate.id !== headId(fmt)) return null
  return fmt
}

/**
 * Whether a ZMS store starts at `region.offset`, and its geometry. The store's
 * first sector is always opened first, so the smallest sector size whose end
 * holds a valid empty ATE is the sector size: an empty ATE is never written
 * anywhere but at a sector end, so a smaller guess cannot match by accident.
 * `granule` is the smallest sector size to try (the flash's erase size).
 */
export function detectZms(
  image: Uint8Array,
  region: ZmsRegion,
  granule: number,
): { sectorSize: number; sectorCount: number; ateSize: number; fmt: Format; version: number } | null {
  const end = Math.min(region.offset + region.size, image.length)
  const size = end - region.offset
  const step = Math.max(granule, 64)
  for (const ateSize of [16, 32]) {
    for (let sectorSize = step; sectorSize * 2 <= size; sectorSize += step) {
      const at = region.offset + sectorSize - ateSize
      const fmt = emptyAteFormat(image, at)
      if (!fmt) continue
      return {
        sectorSize,
        sectorCount: Math.floor(size / sectorSize),
        ateSize,
        fmt,
        version: u32(image, at + 12) & 0xff,
      }
    }
  }
  return null
}

function isBlank(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0xff) return false
  return true
}

interface Slot {
  ate: Ate
  address: number
}

/** Decode the store at `region`, or null when there is none. */
export function readZms(image: Uint8Array, region: ZmsRegion, granule: number): ZmsVolume | null {
  const geo = detectZms(image, region, granule)
  if (!geo) return null
  const { sectorSize: S, sectorCount: n, ateSize: A, fmt } = geo
  const head = headId(fmt)
  const base = (i: number) => region.offset + i * S

  // Sector headers, as zms_init() reads them.
  const empties = Array.from({ length: n }, (_, i) => {
    const at = base(i) + S - A
    const f = emptyAteFormat(image, at)
    return f === fmt ? readAte(image, at, fmt) : null
  })
  const closes = Array.from({ length: n }, (_, i) => readAte(image, base(i) + S - 2 * A, fmt))
  const closed = empties.map((empty, i) => {
    const close = closes[i]
    return (
      !!empty &&
      !!close &&
      close.crcOk &&
      close.cycle === empty.cycle &&
      close.len === 0 &&
      close.id === head &&
      close.offset < S &&
      (S - close.offset) % A === 0
    )
  })

  // How many sectors the store spans is the mount's choice, not the
  // partition's: samples/subsys/kvss/zms mounts 3 sectors of whatever
  // storage_partition the board has. ZMS stamps a sector when it first opens
  // it, so the store wraps after the last stamped sector. Before its first
  // wrap that undercounts, harmlessly: the order only matters once it wraps.
  let span = 0
  for (let i = 0; i < n; i++) if (empties[i]) span = i + 1
  if (span === 0) return null

  let open = -1
  for (let i = 0; i < span; i++) {
    if (closed[i] && !closed[(i + 1) % span]) {
      open = (i + 1) % span
      break
    }
  }
  if (open < 0) {
    if (closed.slice(0, span).every(Boolean)) return null
    // Nothing closed yet: the first sector is in use, unless the last one
    // already holds a valid ATE (a two-sector store that wrapped).
    const last = empties[span - 1]
    const first = readAte(image, base(span - 1) + S - 3 * A, fmt)
    open = span > 1 && last && first && first.crcOk && first.cycle === last.cycle ? span - 1 : 0
  }

  // Valid ATEs per sector, oldest first (they are written downwards). Like
  // zms_recover_last_ate(), an invalid slot is stepped over rather than ending
  // the scan: a freshly formatted sector leaves its first slot, where a
  // gc_done marker would go, blank. In a sector still open the scan ends where
  // the data written so far ends; a closed one says where its last ATE is.
  const slots: Slot[][] = Array.from({ length: n }, (_, i) => {
    const empty = empties[i]
    if (!empty) return []
    const out: Slot[] = []
    let dataEnd = 0
    for (let at = base(i) + S - 3 * A; ; at -= A) {
      if (closed[i] ? at < base(i) + closes[i]!.offset : at <= base(i) + dataEnd) break
      const ate = readAte(image, at, fmt)
      if (!ate || !ate.crcOk || ate.cycle !== empty.cycle) continue
      out.push({ ate, address: at })
      if (ate.id !== head && ate.len > fmt.inlineMax) {
        dataEnd = Math.max(dataEnd, ate.offset + ate.len)
      }
    }
    return out
  })

  // Newest sector first: open, open - 1, ..., wrapping round.
  const order = Array.from({ length: span }, (_, k) => (open - k + span) % span).filter(
    (i) => i === open || closed[i],
  )
  const byId = new Map<bigint, ZmsVersion[]>()
  let age = 0
  for (const i of order) {
    const list = slots[i]!
    for (let k = list.length - 1; k >= 0; k--) {
      const { ate, address } = list[k]!
      if (ate.id === head) continue
      const deleted = ate.len === 0
      let bytes = new Uint8Array(0)
      let dataAddress: number | null = null
      let crcOk: boolean | null = null
      if (!deleted && ate.len <= fmt.inlineMax) {
        bytes = ate.raw.slice(fmt.inlineAt, fmt.inlineAt + ate.len)
      } else if (!deleted) {
        dataAddress = base(i) + ate.offset
        bytes = image.slice(dataAddress, dataAddress + ate.len)
        if (fmt.idBits === 32 && ate.dataCrc !== 0) crcOk = crc32Ieee(bytes) === ate.dataCrc
      }
      const version: ZmsVersion = {
        ateAddress: address,
        sector: i,
        age: age++,
        deleted,
        len: ate.len,
        dataAddress,
        bytes,
        crcOk,
      }
      const versions = byId.get(ate.id) ?? []
      versions.push(version)
      byId.set(ate.id, versions)
    }
  }

  const entries: ZmsEntry[] = [...byId.entries()]
    .map(([id, versions]) => ({
      id,
      idHex: '0x' + id.toString(16).padStart(fmt.idBits / 4, '0'),
      versions,
      live: versions[0]!.deleted ? null : versions[0]!,
    }))
    .sort((a, b) => a.versions[0]!.age - b.versions[0]!.age)

  const sectors: ZmsSector[] = Array.from({ length: n }, (_, i) => {
    const empty = empties[i]
    const list = slots[i]!
    let dataEnd = 0
    for (const { ate } of list) {
      if (ate.id === head) {
        // gc_done carries the data write address at the time it was written.
        if (ate.len === 0 && ate.offset < S) dataEnd = Math.max(dataEnd, ate.offset)
        continue
      }
      if (ate.len > fmt.inlineMax) dataEnd = Math.max(dataEnd, ate.offset + ate.len)
    }
    const lowest = list.length ? list[list.length - 1]!.address - base(i) : S - 2 * A
    const sector = image.subarray(base(i), base(i) + S)
    const state: ZmsSectorState = !empty
      ? isBlank(sector)
        ? 'erased'
        : 'foreign'
      : i === open
        ? 'open'
        : closed[i]
          ? 'closed'
          : 'spare'
    return {
      index: i,
      address: base(i),
      state,
      cycle: empty ? empty.cycle : null,
      ates: empty ? list.length + (closed[i] ? 2 : 1) : 0,
      dataBytes: empty ? dataEnd : 0,
      ateBytes: empty ? (closed[i] ? S - closes[i]!.offset : S - lowest) : 0,
      gcDone: list.some(({ ate }) => ate.id === head && ate.len === 0),
    }
  })

  const volume: ZmsVolume = {
    offset: region.offset,
    sectorSize: S,
    sectorCount: n,
    ateSize: A,
    idBits: fmt.idBits,
    version: geo.version,
    openSector: open,
    sectors,
    entries,
    settings: null,
  }
  volume.settings = fmt.idBits === 32 ? decodeSettings(entries) : null
  return volume
}

function printableName(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null
  for (const b of bytes) if (b < 0x20 || b > 0x7e) return null
  return new TextDecoder().decode(bytes)
}

/** settings_zms's key layout, when the ids follow it. */
function decodeSettings(entries: ZmsEntry[]): ZmsVolume['settings'] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const keys: ZmsSettingsKey[] = []
  const roles = new Map<bigint, ZmsIdRole>()
  for (const entry of entries) {
    const id = Number(entry.id)
    // Name ids: top bits 10, linked-list bit clear, and not the list head.
    if ((id & 0xc0000001) >>> 0 !== 0x80000000 || id === SETTINGS_LL_HEAD) continue
    const named = entry.versions.find((v) => !v.deleted)
    const name = named ? printableName(named.bytes) : null
    if (!name) continue
    const valueId = (id + SETTINGS_DATA_OFFSET) >>> 0
    const value = byId.get(BigInt(valueId))
    keys.push({
      name,
      nameId: id,
      valueId,
      versions: value?.versions ?? [],
      // A key is gone when either half reads back as deleted.
      live: entry.live && value?.live ? value.live : null,
    })
    roles.set(entry.id, { kind: 'name', key: name })
    roles.set(BigInt(valueId), { kind: 'value', key: name })
    roles.set(BigInt((id | 1) >>> 0), { kind: 'list', key: name })
  }
  if (keys.length === 0) return null
  roles.set(BigInt(SETTINGS_LL_HEAD), { kind: 'head' })
  keys.sort((a, b) => a.name.localeCompare(b.name))
  return { keys, roles }
}

/**
 * Every ZMS store on a flash image: one per region (the chip's devicetree
 * partitions), or the whole image when no partition is known.
 */
export function findZmsVolumes(
  image: Uint8Array,
  regions: ZmsRegion[],
  granule: number,
): ZmsVolume[] {
  const list = regions.length ? regions : [{ offset: 0, size: image.length }]
  const out: ZmsVolume[] = []
  for (const region of list) {
    const volume = readZms(image, region, granule)
    if (volume) out.push(volume)
  }
  return out
}
