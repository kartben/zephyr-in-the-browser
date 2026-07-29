/**
 * Read-only FAT12/16/32 reader, for browsing a virtio-blk image in the page.
 *
 * The LittleFS side of the dock vendors the real C implementation
 * (src/vendor/littlefs-js) because a TS reimplementation could not be trusted
 * against Zephyr-formatted volumes. FAT does not need that: the on-disk format
 * is small, frozen since the 1990s, and this only ever reads. What FatFS
 * produces on the guest side — `f_mkfs()` with default options over a 4 MiB
 * disk, so FAT12 with 512 B sectors — is squarely in the middle of it.
 *
 * Deliberately not supported, because nothing here writes them: exFAT, and
 * anything below a 512-byte sector.
 */

import type { FsBrowseResult, FsTreeDir, FsTreeNode } from '@/lib/fsTree'

/** Directory entry attribute bits (FAT spec, table "File Attributes"). */
const ATTR_READ_ONLY = 0x01
const ATTR_HIDDEN = 0x02
const ATTR_SYSTEM = 0x04
const ATTR_VOLUME_ID = 0x08
const ATTR_DIRECTORY = 0x10
const ATTR_LONG_NAME = ATTR_READ_ONLY | ATTR_HIDDEN | ATTR_SYSTEM | ATTR_VOLUME_ID

const DIR_ENTRY_SIZE = 32
const FREE_ENTRY = 0x00
const DELETED_ENTRY = 0xe5
/** 0x05 stands in for a real leading 0xE5 in a short name (KANJI lead byte). */
const KANJI_E5 = 0x05

/** Guard against a corrupt FAT sending the cluster walk in circles. */
const MAX_CLUSTER_CHAIN = 1 << 20

export type FatKind = 'FAT12' | 'FAT16' | 'FAT32'

export interface FatGeometry {
  kind: FatKind
  bytesPerSector: number
  sectorsPerCluster: number
  clusterCount: number
  label: string | null
}

/** Everything the layout math needs, derived once from the BPB. */
interface FatVolume {
  image: Uint8Array
  view: DataView
  geom: FatGeometry
  fatStart: number
  rootDirStart: number
  /** 0 on FAT32, where the root is a normal cluster chain. */
  rootDirSectors: number
  rootCluster: number
  dataStart: number
}

export class FatError extends Error {}

function u8(v: DataView, off: number) {
  return v.getUint8(off)
}
function u16(v: DataView, off: number) {
  return v.getUint16(off, true)
}
function u32(v: DataView, off: number) {
  return v.getUint32(off, true)
}

/**
 * Parse the BIOS Parameter Block and derive the region layout.
 *
 * The FAT type is *defined* by the cluster count, not by anything stored on
 * disk — this is the standard determination from the Microsoft spec, and the
 * only correct way to read the FAT.
 */
function readVolume(image: Uint8Array): FatVolume {
  if (image.length < 512) {
    throw new FatError('image shorter than one sector')
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength)

  const bytesPerSector = u16(view, 11)
  if (bytesPerSector < 512 || (bytesPerSector & (bytesPerSector - 1)) !== 0) {
    throw new FatError(`implausible bytes-per-sector ${bytesPerSector}`)
  }

  const sectorsPerCluster = u8(view, 13)
  if (sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0) {
    throw new FatError(`implausible sectors-per-cluster ${sectorsPerCluster}`)
  }

  const reservedSectors = u16(view, 14)
  const numFats = u8(view, 16)
  const rootEntryCount = u16(view, 17)
  const totalSectors16 = u16(view, 19)
  const fatSize16 = u16(view, 22)
  const totalSectors32 = u32(view, 32)
  const fatSize32 = u32(view, 36)

  if (reservedSectors === 0 || numFats === 0) {
    throw new FatError('no reserved sectors or no FATs — not a FAT volume')
  }

  const fatSize = fatSize16 !== 0 ? fatSize16 : fatSize32
  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32
  if (fatSize === 0 || totalSectors === 0) {
    throw new FatError('zero FAT size or total sectors — not a FAT volume')
  }

  // Root directory is a fixed region on FAT12/16 and a cluster chain on FAT32,
  // where rootEntryCount is 0.
  const rootDirSectors = Math.ceil((rootEntryCount * DIR_ENTRY_SIZE) / bytesPerSector)
  const dataStartSector = reservedSectors + numFats * fatSize + rootDirSectors
  if (dataStartSector >= totalSectors) {
    throw new FatError('data region starts past the end of the volume')
  }
  const clusterCount = Math.floor((totalSectors - dataStartSector) / sectorsPerCluster)

  const kind: FatKind = clusterCount < 4085 ? 'FAT12' : clusterCount < 65525 ? 'FAT16' : 'FAT32'

  return {
    image,
    view,
    geom: {
      kind,
      bytesPerSector,
      sectorsPerCluster,
      clusterCount,
      label: readVolumeLabel(view, kind),
    },
    fatStart: reservedSectors * bytesPerSector,
    rootDirStart: (reservedSectors + numFats * fatSize) * bytesPerSector,
    rootDirSectors,
    rootCluster: kind === 'FAT32' ? u32(view, 44) : 0,
    dataStart: dataStartSector * bytesPerSector,
  }
}

/** BS_VolLab, at a different offset on FAT32. Trailing-space padded. */
function readVolumeLabel(view: DataView, kind: FatKind): string | null {
  const off = kind === 'FAT32' ? 71 : 43
  if (off + 11 > view.byteLength) return null
  let out = ''
  for (let i = 0; i < 11; i++) {
    out += String.fromCharCode(u8(view, off + i))
  }
  out = out.trimEnd()
  return out && out !== 'NO NAME' ? out : null
}

/** Follow the FAT to the next cluster, or null at end-of-chain / on error. */
function nextCluster(vol: FatVolume, cluster: number): number | null {
  const { view, fatStart, geom } = vol
  let value: number

  if (geom.kind === 'FAT12') {
    // 12 bits per entry: consecutive entries share a byte, and the half taken
    // depends on the cluster's parity.
    const off = fatStart + cluster + (cluster >> 1)
    if (off + 1 >= view.byteLength) return null
    const pair = u16(view, off)
    value = cluster & 1 ? pair >> 4 : pair & 0x0fff
    return value >= 0xff8 || value < 2 ? null : value
  }

  if (geom.kind === 'FAT16') {
    const off = fatStart + cluster * 2
    if (off + 1 >= view.byteLength) return null
    value = u16(view, off)
    return value >= 0xfff8 || value < 2 ? null : value
  }

  const off = fatStart + cluster * 4
  if (off + 3 >= view.byteLength) return null
  value = u32(view, off) & 0x0fffffff
  return value >= 0x0ffffff8 || value < 2 ? null : value
}

/** Byte offset of a data cluster. Clusters are numbered from 2. */
function clusterOffset(vol: FatVolume, cluster: number): number {
  return vol.dataStart + (cluster - 2) * vol.geom.sectorsPerCluster * vol.geom.bytesPerSector
}

/**
 * Concatenate a cluster chain, stopping at `limit` bytes when given (a file's
 * recorded size — the last cluster is normally only partly used).
 */
function readChain(vol: FatVolume, firstCluster: number, limit?: number): Uint8Array {
  const clusterBytes = vol.geom.sectorsPerCluster * vol.geom.bytesPerSector
  const chunks: Uint8Array[] = []
  let total = 0
  let cluster: number | null = firstCluster
  let guard = 0

  while (cluster !== null && cluster >= 2) {
    if (++guard > MAX_CLUSTER_CHAIN) {
      throw new FatError('cluster chain does not terminate')
    }
    const start = clusterOffset(vol, cluster)
    if (start < 0 || start >= vol.image.length) break
    const end = Math.min(start + clusterBytes, vol.image.length)
    chunks.push(vol.image.subarray(start, end))
    total += end - start
    if (limit !== undefined && total >= limit) break
    cluster = nextCluster(vol, cluster)
  }

  const size = limit !== undefined ? Math.min(limit, total) : total
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    if (at >= size) break
    const take = Math.min(chunk.length, size - at)
    out.set(chunk.subarray(0, take), at)
    at += take
  }
  return out
}

/** The bytes of a directory: a fixed region on FAT12/16 root, else a chain. */
function readDirectoryBytes(vol: FatVolume, cluster: number): Uint8Array {
  if (cluster === 0 && vol.geom.kind !== 'FAT32') {
    const start = vol.rootDirStart
    const end = Math.min(start + vol.rootDirSectors * vol.geom.bytesPerSector, vol.image.length)
    return vol.image.subarray(start, end)
  }
  return readChain(vol, cluster === 0 ? vol.rootCluster : cluster)
}

/** "NAME    EXT" → "NAME.EXT". */
function shortName(entry: Uint8Array): string {
  const raw = Array.from(entry.subarray(0, 11), (b) => String.fromCharCode(b))
  if (entry[0] === KANJI_E5) raw[0] = String.fromCharCode(DELETED_ENTRY)
  const base = raw.slice(0, 8).join('').trimEnd()
  const ext = raw.slice(8, 11).join('').trimEnd()
  return ext ? `${base}.${ext}` : base
}

/**
 * The UCS-2 fragment carried by one long-name entry: 5 chars, then 6, then 2,
 * scattered around the fields the short-name layout already claimed.
 */
function longNameChunk(view: DataView, off: number): string {
  const at = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]
  let out = ''
  for (const i of at) {
    const code = u16(view, off + i)
    if (code === 0x0000 || code === 0xffff) break
    out += String.fromCharCode(code)
  }
  return out
}

interface DirEntry {
  name: string
  isDir: boolean
  size: number
  cluster: number
}

function readDirectory(vol: FatVolume, cluster: number): DirEntry[] {
  const bytes = readDirectoryBytes(vol, cluster)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: DirEntry[] = []
  /* Long-name entries precede their short entry, in reverse order. */
  let longParts: string[] = []

  for (let off = 0; off + DIR_ENTRY_SIZE <= bytes.length; off += DIR_ENTRY_SIZE) {
    const first = u8(view, off)
    if (first === FREE_ENTRY) break
    if (first === DELETED_ENTRY) {
      longParts = []
      continue
    }

    const attr = u8(view, off + 11)
    if ((attr & ATTR_LONG_NAME) === ATTR_LONG_NAME) {
      longParts.unshift(longNameChunk(view, off))
      continue
    }
    if (attr & ATTR_VOLUME_ID) {
      longParts = []
      continue
    }

    const entry = bytes.subarray(off, off + DIR_ENTRY_SIZE)
    const name = longParts.length > 0 ? longParts.join('') : shortName(entry)
    longParts = []

    if (name === '.' || name === '..') continue

    out.push({
      name,
      isDir: (attr & ATTR_DIRECTORY) !== 0,
      size: u32(view, off + 28),
      cluster: (u16(view, off + 20) << 16) | u16(view, off + 26),
    })
  }

  return out
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/**
 * Walk from `cluster` into a tree. `depth` bounds recursion so a self-
 * referential directory cannot hang the page.
 */
function walk(
  vol: FatVolume,
  cluster: number,
  path: string,
  files: FsBrowseResult['files'],
  depth: number,
): FsTreeNode[] {
  if (depth > 16) return []

  return readDirectory(vol, cluster).map((entry): FsTreeNode => {
    const childPath = joinPath(path, entry.name)
    if (entry.isDir) {
      return {
        kind: 'dir',
        name: entry.name,
        path: childPath,
        children: walk(vol, entry.cluster, childPath, files, depth + 1),
      }
    }
    const content = entry.cluster >= 2 ? readChain(vol, entry.cluster, entry.size) : new Uint8Array(0)
    files.push({ path: childPath, size: entry.size, content })
    return { kind: 'file', name: entry.name, path: childPath, size: entry.size, content }
  })
}

/** True when the image has no boot signature — i.e. nothing formatted it yet. */
export function isBlankDisk(image: Uint8Array): boolean {
  if (image.length < 512) return true
  // 0xAA55 at the end of sector 0 is what f_mkfs writes; without it there is
  // no volume, whatever else the bytes hold.
  return !(image[510] === 0x55 && image[511] === 0xaa)
}

/** Read geometry only — enough for a capacity readout, without a full walk. */
export function readFatGeometry(image: Uint8Array): FatGeometry | null {
  try {
    return readVolume(image).geom
  } catch {
    return null
  }
}

/**
 * Browse a FAT image. Returns null when the image holds no volume at all,
 * which the shared dialog renders differently from a mounted-but-empty one.
 */
export function browseFat(image: Uint8Array): FsBrowseResult | null {
  if (image.length === 0 || isBlankDisk(image)) return null

  const vol = readVolume(image)
  const files: FsBrowseResult['files'] = []
  const root: FsTreeDir = {
    kind: 'dir',
    name: '/',
    path: '/',
    children: [],
  }

  let error: string | undefined
  try {
    root.children = walk(vol, 0, '/', files, 0)
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  const { kind, clusterCount, sectorsPerCluster, bytesPerSector, label } = vol.geom
  const clusterBytes = sectorsPerCluster * bytesPerSector
  const summary =
    `${kind}${label ? ` "${label}"` : ''} · ` +
    `${clusterCount} × ${clusterBytes} B clusters · ${bytesPerSector} B sectors`

  return { summary, files, root, error }
}
