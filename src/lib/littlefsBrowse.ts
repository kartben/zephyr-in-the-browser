/**
 * Browse a LittleFS v2 image from SPI NOR bytes.
 *
 * Mounts with the real littlefs C library via Dreagonmon's littlefs-js
 * (vendored under src/vendor/littlefs-js, rebuilt for littlefs v2.11 / disk
 * v2.1 so Zephyr-formatted volumes mount). A pure-TS reimplementation was not
 * reliable against Zephyr images (live move/global state, CTZ layout with
 * 64 KiB SPI-NOR layout pages).
 */

import {
  BlockDevice,
  LFS,
  LFSModule,
  LFS_O_RDONLY,
  LFS_TYPE_DIR,
  LFS_TYPE_REG,
  type LFSInfo,
} from '@/vendor/littlefs-js/lfs_js.js'

/**
 * Dreagonmon littlefs-js is one Emscripten/Asyncify module. Overlapping
 * `lfs_*` calls abort with "We cannot start an async operation when one is
 * already flight". Serialize every mount/format/browse through this queue.
 */
let littlefsTail: Promise<unknown> = Promise.resolve()

export function withLittlefsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = littlefsTail.then(fn, fn)
  littlefsTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export interface LittlefsTreeFile {
  kind: 'file'
  name: string
  path: string
  size: number
  content: Uint8Array
}

export interface LittlefsTreeDir {
  kind: 'dir'
  name: string
  path: string
  children: LittlefsTreeNode[]
}

export type LittlefsTreeNode = LittlefsTreeFile | LittlefsTreeDir

export interface LittlefsSuperblockInfo {
  blockSize: number
  blockCount: number
}

export interface LittlefsBrowseResult {
  superblock: LittlefsSuperblockInfo
  files: Array<{ path: string; size: number; content: Uint8Array }>
  root: LittlefsTreeDir
  /** Set when mount succeeded but listing hit an error. */
  error?: string
}

export interface LittlefsBrowseFailure {
  error: string
}

/** True when the image looks erased (no LittleFS yet). */
export function isBlankFlash(image: Uint8Array, erased = 0xff): boolean {
  const step = Math.max(1, Math.floor(image.length / 64))
  for (let i = 0; i < image.length; i += step) {
    if (image[i] !== erased) return false
  }
  for (let i = 0; i < Math.min(image.length, 8192); i++) {
    if (image[i] !== erased) return false
  }
  return true
}

/** Scan for the on-disk "littlefs" magic (hints a filesystem is present). */
export function findLittlefsMagic(image: Uint8Array): number | null {
  const hits = findLittlefsMagicOffsets(image, 1)
  return hits[0] ?? null
}

/** All "littlefs" magic offsets in the first `limit` bytes. */
export function findLittlefsMagicOffsets(image: Uint8Array, maxHits = 8, limit = 256 * 1024): number[] {
  const magic = [0x6c, 0x69, 0x74, 0x74, 0x6c, 0x65, 0x66, 0x73] // littlefs
  const end = Math.min(image.length - 8, limit)
  const hits: number[] = []
  for (let i = 0; i < end; i++) {
    let ok = true
    for (let j = 0; j < 8; j++) {
      if (image[i + j] !== magic[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      hits.push(i)
      if (hits.length >= maxHits) break
    }
  }
  return hits
}

/**
 * Infer LittleFS block_size from the distance between the two superblock
 * magics (blocks 0 and 1). Returns null when the image is incomplete.
 */
export function detectLittlefsBlockSize(image: Uint8Array): number | null {
  const hits = findLittlefsMagicOffsets(image, 2)
  if (hits.length < 2) return null
  const diff = hits[1]! - hits[0]!
  if (diff > 0 && (diff & (diff - 1)) === 0 && image.length % diff === 0) return diff
  return null
}

/**
 * Block sizes Zephyr may have used. Stock SPI_NOR_FLASH_LAYOUT_PAGE_SIZE is
 * 65536; we pin packaged samples to 4096 (erase sector). Prefer a size
 * detected from the on-disk superblock pair when available.
 */
function blockSizeCandidates(preferred?: number, detected?: number | null): number[] {
  const out: number[] = []
  for (const n of [detected, preferred, 4096, 65536, 32768, 8192]) {
    if (n && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** Read-only block device over a flash image (0xff for out-of-range). */
class ImageBlockDevice extends BlockDevice {
  private readonly image: Uint8Array

  constructor(image: Uint8Array, blockSize: number, readSize = 16, progSize = 16) {
    super()
    this.image = image
    this.block_size = blockSize
    this.block_count = Math.floor(image.length / blockSize)
    this.read_size = readSize
    this.prog_size = progSize
  }

  // async like MemoryBlockDevice — Asyncify may resume through these.
  async read(block: number, off: number, buffer: number, size: number): Promise<number> {
    const start = block * this.block_size + off
    for (let i = 0; i < size; i++) {
      const addr = start + i
      LFSModule.HEAPU8[buffer + i] = addr >= 0 && addr < this.image.length ? this.image[addr]! : 0xff
    }
    return 0
  }

  async prog(_block: number, _off: number, _buffer: number, _size: number): Promise<number> {
    return 0 // read-only browser
  }

  async erase(_block: number): Promise<number> {
    return 0
  }
}

/**
 * Mount-and-list a LittleFS image with the real littlefs library.
 * Returns `null` when the flash is blank; throws / returns `{ error }` details
 * via the result object when mount fails on non-blank flash.
 */
export async function browseLittlefs(
  image: Uint8Array,
  opts: { blockSize?: number; readSize?: number; progSize?: number } = {},
): Promise<LittlefsBrowseResult | null> {
  return withLittlefsLock(() => browseLittlefsUnlocked(image, opts))
}

async function browseLittlefsUnlocked(
  image: Uint8Array,
  opts: { blockSize?: number; readSize?: number; progSize?: number },
): Promise<LittlefsBrowseResult | null> {
  if (image.length === 0 || isBlankFlash(image)) return null

  // Snapshot so guest SPI traffic cannot tear CRC reads mid-mount.
  const snap = image.slice()
  const magicAt = findLittlefsMagic(snap)
  const detected = detectLittlefsBlockSize(snap)
  let lastErr =
    magicAt === null
      ? 'no littlefs magic in image'
      : `mount failed (magic @ 0x${magicAt.toString(16)}${detected ? `, ~${detected} B blocks` : ''})`
  const attempts: string[] = []

  for (const blockSize of blockSizeCandidates(opts.blockSize, detected)) {
    if (snap.length < blockSize * 2 || snap.length % blockSize !== 0) continue
    const bd = new ImageBlockDevice(snap, blockSize, opts.readSize ?? 16, opts.progSize ?? 16)
    const lfs = new LFS(bd, 512)
    let mountRc: number
    try {
      mountRc = await lfs.mount()
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      attempts.push(`lfs_mount(${blockSize}) threw: ${lastErr}`)
      continue
    }
    if (typeof mountRc === 'number' && mountRc < 0) {
      lastErr = `lfs_mount(${blockSize}) → ${mountRc}${mountRc === -84 ? ' (CORRUPT)' : mountRc === -22 ? ' (INVAL)' : ''}`
      attempts.push(lastErr)
      continue
    }
    try {
      const files: Array<{ path: string; size: number; content: Uint8Array }> = []
      const root = await walkDir(lfs, '/', files)
      return {
        superblock: { blockSize, blockCount: bd.block_count },
        files,
        root,
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      attempts.push(`list@${blockSize}: ${lastErr}`)
    } finally {
      try {
        await lfs.unmount()
      } catch {
        /* ignore */
      }
    }
  }

  return {
    superblock: { blockSize: detected ?? opts.blockSize ?? 4096, blockCount: 0 },
    files: [],
    root: { kind: 'dir', name: '/', path: '/', children: [] },
    error: attempts.length > 1 ? `${lastErr} · tried: ${attempts.join('; ')}` : lastErr,
  }
}

async function walkDir(
  lfs: LFS,
  path: string,
  files: Array<{ path: string; size: number; content: Uint8Array }>,
): Promise<LittlefsTreeDir> {
  const name = path === '/' ? '/' : path.split('/').filter(Boolean).pop()!
  const node: LittlefsTreeDir = { kind: 'dir', name, path, children: [] }
  const dir = await lfs.opendir(path)
  if (typeof dir === 'number') {
    throw new Error(`opendir ${path} → ${dir}`)
  }
  try {
    for (;;) {
      const ent = (await dir.read()) as LFSInfo | null | number
      if (ent === null || ent === undefined) break
      if (typeof ent === 'number') {
        if (ent < 0) throw new Error(`readdir ${path} → ${ent}`)
        break
      }
      if (ent.name === '.' || ent.name === '..') continue
      const childPath = path === '/' ? `/${ent.name}` : `${path}/${ent.name}`
      if (ent.type === LFS_TYPE_DIR) {
        node.children.push(await walkDir(lfs, childPath, files))
      } else if (ent.type === LFS_TYPE_REG) {
        const content = await readFile(lfs, childPath, ent.size)
        files.push({ path: childPath, size: content.length, content })
        node.children.push({
          kind: 'file',
          name: ent.name,
          path: childPath,
          size: content.length,
          content,
        })
      }
    }
  } finally {
    await dir.close()
  }
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return node
}

async function readFile(lfs: LFS, path: string, hintSize: number): Promise<Uint8Array> {
  const file = await lfs.open(path, LFS_O_RDONLY)
  if (typeof file === 'number') throw new Error(`open ${path} → ${file}`)
  try {
    const size = hintSize > 0 ? hintSize : await file.size()
    if (size <= 0) return new Uint8Array(0)
    const data = await file.read(size)
    if (typeof data === 'number') throw new Error(`read ${path} → ${data}`)
    return data
  } finally {
    await file.close()
  }
}

/** Decode file bytes as UTF-8 when printable; otherwise hex. */
export function previewFileContent(
  bytes: Uint8Array,
  max = 512,
): { kind: 'text' | 'hex'; text: string } {
  const slice = bytes.length > max ? bytes.subarray(0, max) : bytes
  let printable = true
  for (let i = 0; i < slice.length; i++) {
    const b = slice[i]!
    if (b === 9 || b === 10 || b === 13) continue
    if (b < 32 || b > 126) {
      printable = false
      break
    }
  }
  if (printable) {
    const text = new TextDecoder().decode(slice) + (bytes.length > max ? '…' : '')
    return { kind: 'text', text }
  }
  let hex = ''
  for (let i = 0; i < slice.length; i++) {
    if (i && i % 16 === 0) hex += '\n'
    else if (i) hex += ' '
    hex += slice[i]!.toString(16).padStart(2, '0')
  }
  if (bytes.length > max) hex += '\n…'
  return { kind: 'hex', text: hex }
}
