import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LFS,
  LFS_O_CREAT,
  LFS_O_TRUNC,
  LFS_O_WRONLY,
  MemoryBlockDevice,
} from '@/vendor/littlefs-js/lfs_js.js'
import { browseLittlefs, isBlankFlash, previewFileContent, withLittlefsLock } from './littlefsBrowse'

async function makeImage(opts: {
  blockSize: number
  blockCount: number
  files: Array<{ path: string; data: Uint8Array }>
  dirs?: string[]
}): Promise<Uint8Array> {
  return withLittlefsLock(async () => {
    const bdev = new MemoryBlockDevice(opts.blockSize, opts.blockCount)
    bdev.read_size = 16
    bdev.prog_size = 16
    const lfs = new LFS(bdev, 512)
    expect(await lfs.format()).toBe(0)
    expect(await lfs.mount()).toBe(0)
    for (const dir of opts.dirs ?? []) {
      expect(await lfs.mkdir(dir)).toBe(0)
    }
    for (const file of opts.files) {
      const fh = await lfs.open(file.path, LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC)
      expect(typeof fh === 'number' ? fh : 0).toBe(0)
      if (typeof fh === 'number') throw new Error('open failed')
      await fh.write(file.data)
      await fh.close()
    }
    await lfs.unmount()

    const image = new Uint8Array(opts.blockSize * opts.blockCount).fill(0xff)
    for (let i = 0; i < bdev._storage.length; i++) {
      const block = bdev._storage[i]
      if (block) image.set(block, i * opts.blockSize)
    }
    return image
  })
}

describe('littlefsBrowse', () => {
  it('treats all-0xff images as blank', () => {
    expect(isBlankFlash(new Uint8Array(4096).fill(0xff))).toBe(true)
    const dirty = new Uint8Array(4096).fill(0xff)
    dirty[100] = 0x00
    expect(isBlankFlash(dirty)).toBe(false)
  })

  it('lists files from a real littlefs 4 KiB-block image', async () => {
    const image = await makeImage({
      blockSize: 4096,
      blockCount: 64,
      dirs: ['/cfg'],
      files: [
        { path: '/boot_count', data: new Uint8Array([3, 0, 0, 0]) },
        { path: '/cfg/note.txt', data: new TextEncoder().encode('hi') },
      ],
    })
    const result = await browseLittlefs(image, { blockSize: 4096 })
    expect(result).not.toBeNull()
    expect(result!.error).toBeUndefined()
    expect(result!.files.map((f) => f.path).sort()).toEqual(['/boot_count', '/cfg/note.txt'])
    expect([...result!.files.find((f) => f.path === '/boot_count')!.content]).toEqual([3, 0, 0, 0])
    expect(result!.root.children.some((c) => c.kind === 'dir' && c.name === 'cfg')).toBe(true)
  })

  it('also mounts Zephyr-default 64 KiB layout-page images', async () => {
    const image = await makeImage({
      blockSize: 65536,
      blockCount: 16,
      files: [
        { path: '/boot_count', data: new Uint8Array([7]) },
        { path: '/pattern.bin', data: Uint8Array.from({ length: 547 }, (_, i) => i & 0xff) },
      ],
    })
    // Prefer 4 KiB first (as the dock does); browser must still find 64 KiB.
    const result = await browseLittlefs(image, { blockSize: 4096 })
    expect(result).not.toBeNull()
    expect(result!.error).toBeUndefined()
    expect(result!.superblock.blockSize).toBe(65536)
    expect(result!.files.map((f) => f.path).sort()).toEqual(['/boot_count', '/pattern.bin'])
    expect(result!.files.find((f) => f.path === '/pattern.bin')!.size).toBe(547)
  })

  it('serializes concurrent browses so Asyncify does not abort', async () => {
    const image = await makeImage({
      blockSize: 4096,
      blockCount: 32,
      files: [{ path: '/boot_count', data: new Uint8Array([9, 0, 0, 0]) }],
    })
    const [a, b, c] = await Promise.all([
      browseLittlefs(image, { blockSize: 4096 }),
      browseLittlefs(image, { blockSize: 4096 }),
      browseLittlefs(image, { blockSize: 4096 }),
    ])
    for (const result of [a, b, c]) {
      expect(result).not.toBeNull()
      expect(result!.error).toBeUndefined()
      expect(result!.files.map((f) => f.path)).toEqual(['/boot_count'])
    }
  })

  it('returns null for blank flash', async () => {
    expect(await browseLittlefs(new Uint8Array(8192).fill(0xff))).toBeNull()
  })

  it('previews text vs hex', () => {
    expect(previewFileContent(new TextEncoder().encode('hello')).kind).toBe('text')
    expect(previewFileContent(Uint8Array.of(0x00, 0xff, 0x10)).kind).toBe('hex')
  })
})

describe('W25Q sparse persist', () => {
  class MemoryStorage {
    private store = new Map<string, string>()
    getItem(k: string) {
      return this.store.has(k) ? this.store.get(k)! : null
    }
    setItem(k: string, v: string) {
      this.store.set(k, String(v))
    }
    removeItem(k: string) {
      this.store.delete(k)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', new MemoryStorage())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reloads programmed sectors across createW25q', async () => {
    const { createW25q } = await import('@/virtio/devices/chips/w25q')
    const key = 'test.w25q'
    const size = 1024 * 1024
    const first = createW25q({ cs: 0, size, persistKey: key })
    first.poke(0, 0x12)
    first.poke(5000, 0xab)
    vi.advanceTimersByTime(300)

    const raw = localStorage.getItem(key)
    expect(raw).toBeTruthy()
    expect(raw!).toContain('"v":1')
    expect(raw!.length).toBeLessThan(size)

    const second = createW25q({ cs: 0, size, persistKey: key })
    expect(second.memory[0]).toBe(0x12)
    expect(second.memory[5000]).toBe(0xab)
    expect(second.memory[100]).toBe(0xff)
  })

  it('erase clears the persist key', async () => {
    const { createW25q } = await import('@/virtio/devices/chips/w25q')
    const key = 'test.w25q.erase'
    const chip = createW25q({ cs: 0, size: 8192, persistKey: key })
    chip.poke(10, 0x55)
    vi.advanceTimersByTime(300)
    expect(localStorage.getItem(key)).not.toBeNull()
    chip.erase()
    expect(localStorage.getItem(key)).toBeNull()
  })
})
