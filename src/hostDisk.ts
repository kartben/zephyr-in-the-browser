/**
 * Browser end of the virtio-blk backing store.
 *
 * The disk behind `-device virtio-blk-device` is a raw image the page
 * allocates in Emscripten's MEMFS (see `blankFiles` in src/boards.ts). QEMU's
 * own block layer reads and writes it, so unlike every other peripheral here
 * the bytes are not ours — this module polls them back out, the same way
 * hostTrace.ts follows the guest's CTF stream.
 *
 * That polling is the one structural difference from the SPI NOR flash model,
 * which owns its bytes and pushes changes to the dock. MEMFS bumps a node's
 * timestamp on write, so a stat is enough to know when to look again.
 *
 * What the panel gets out of it:
 *   - a {@link HexBacked} facade, so HexView/HexPreview work unchanged;
 *   - a written-block bitmap, the analogue of the flash sector map;
 *   - a change signal the FAT browser can subscribe to.
 */

import { register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'
import type { HexBacked } from '@/virtio/devices/memory/model'

/** Must match the `blankFiles` path of the sample that declares a disk. */
const DISK_PATHS = ['/pack/virtio-blk.img', 'pack/virtio-blk.img']
const POLL_ID = 'disk'
const POLL_MS = 500

/**
 * Target cell count for the block map. A 4 MiB disk has 8192 512-byte sectors,
 * far too many to paint one cell each, so sectors are grouped into blocks
 * sized to land near this — the same visual density as the flash sector map.
 */
const TARGET_BLOCKS = 256

interface EmscriptenFS {
  analyzePath?: (path: string) => {
    exists: boolean
    object?: { contents?: Uint8Array; usedBytes?: number }
  }
  stat?: (path: string) => { size: number; mtime: Date }
}

interface DiskModule {
  FS?: EmscriptenFS
}

export interface DiskSnapshot {
  /** True once the image has been found in the emulator filesystem. */
  available: boolean
  path: string | null
  sizeBytes: number
  /** Bytes covered by one cell of {@link written}. */
  blockBytes: number
  /** One entry per block: true once any byte in it is non-zero. */
  written: boolean[]
  writtenBlocks: number
  /** Bumped whenever the image changed, so consumers can memoise. */
  revision: number
}

const EMPTY: DiskSnapshot = {
  available: false,
  path: null,
  sizeBytes: 0,
  blockBytes: 0,
  written: [],
  writtenBlocks: 0,
  revision: 0,
}

let mod: DiskModule | null = null
let snapshot: DiskSnapshot = EMPTY
let path: string | null = null
let lastMtime = -1
let lastSize = -1
let revision = 0
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function findDisk(fs: EmscriptenFS): string | null {
  for (const candidate of DISK_PATHS) {
    try {
      if (fs.analyzePath?.(candidate).exists) return candidate
    } catch {
      /* try next */
    }
  }
  return null
}

/** A live view into MEMFS — no copy, so a poll does not clone the image. */
function contentsOf(fs: EmscriptenFS, file: string): Uint8Array | null {
  try {
    const info = fs.analyzePath?.(file)
    const contents = info?.object?.contents
    if (!contents) return null
    const length = info?.object?.usedBytes ?? contents.length
    return contents.subarray(0, length)
  } catch {
    return null
  }
}

/** Round the block size up to a power of two at or above size/TARGET_BLOCKS. */
function blockBytesFor(sizeBytes: number): number {
  const ideal = Math.max(512, Math.ceil(sizeBytes / TARGET_BLOCKS))
  let block = 512
  while (block < ideal) block *= 2
  return block
}

/**
 * Which blocks hold data. QEMU tells us nothing about what it wrote, so this
 * is inferred: the image starts all-zero, so any non-zero byte is the guest's.
 * Scanned 32 bits at a time, and only when the file's mtime moved.
 */
export function scanWritten(bytes: Uint8Array, blockBytes: number): boolean[] {
  const blocks = Math.ceil(bytes.length / blockBytes)
  const out = new Array<boolean>(blocks).fill(false)

  // A Uint32Array view needs a 4-aligned byte offset; MEMFS gives no such
  // guarantee, so fall back to a byte scan rather than throwing.
  const aligned = bytes.byteOffset % 4 === 0
  const words = aligned
    ? new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4))
    : null

  for (let b = 0; b < blocks; b++) {
    const from = b * blockBytes
    const to = Math.min(from + blockBytes, bytes.length)

    if (words) {
      let hit = false
      const wEnd = Math.floor(to / 4)
      for (let w = Math.floor(from / 4); w < wEnd; w++) {
        if (words[w] !== 0) {
          hit = true
          break
        }
      }
      // Whatever the word loop could not cover (a ragged final block).
      if (!hit) {
        for (let i = wEnd * 4; i < to; i++) {
          if (bytes[i]) {
            hit = true
            break
          }
        }
      }
      out[b] = hit
      continue
    }

    for (let i = from; i < to; i++) {
      if (bytes[i]) {
        out[b] = true
        break
      }
    }
  }
  return out
}

function sample() {
  const fs = mod?.FS
  if (!fs) return

  if (!path) {
    path = findDisk(fs)
    if (!path) return
  }

  let size = 0
  let mtime = 0
  try {
    const st = fs.stat?.(path)
    if (!st) return
    size = st.size
    mtime = st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime)
  } catch {
    return
  }

  // Nothing has touched the image since the last look.
  if (mtime === lastMtime && size === lastSize && snapshot.available) return
  lastMtime = mtime
  lastSize = size

  const bytes = contentsOf(fs, path)
  if (!bytes) return

  const blockBytes = blockBytesFor(bytes.length)
  const written = scanWritten(bytes, blockBytes)

  revision++
  snapshot = {
    available: true,
    path,
    sizeBytes: bytes.length,
    blockBytes,
    written,
    writtenBlocks: written.reduce((n, w) => n + (w ? 1 : 0), 0),
    revision,
  }
  notify()
}

export function attach(instance: unknown) {
  detach()
  mod = instance as DiskModule
  sample()
  registerPoll(POLL_ID, POLL_MS, sample)
}

export function detach() {
  unregisterPoll(POLL_ID)
  mod = null
  path = null
  lastMtime = -1
  lastSize = -1
  revision = 0
  if (snapshot !== EMPTY) {
    snapshot = EMPTY
    notify()
  }
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): DiskSnapshot {
  return snapshot
}

/**
 * The image bytes, live. Callers must not retain this across polls — MEMFS may
 * reallocate the backing buffer when the file grows.
 */
export function readImage(): Uint8Array | null {
  const fs = mod?.FS
  if (!fs || !path) return null
  return contentsOf(fs, path)
}

/**
 * A {@link HexBacked} view of the disk, so the hex dump and its preview strip
 * work with no changes. Read-only: `poke` is a no-op because QEMU owns these
 * bytes and would not see a page-side edit.
 */
export function createDiskHexChip(): HexBacked {
  return {
    get memory() {
      return readImage() ?? new Uint8Array(0)
    },
    get decl() {
      return { size: snapshot.sizeBytes, erased: 0x00 }
    },
    version: () => snapshot.revision,
    pointer: () => -1,
    poke() {
      /* QEMU owns the image; a page-side write would be silently overwritten */
    },
    erase() {
      /* likewise — the guest formats the disk, not the page */
    },
    subscribe,
  }
}
