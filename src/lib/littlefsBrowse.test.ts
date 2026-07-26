import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generate } from 'partitions-tool-esp/littlefs'
import { createDir, createFile } from 'partitions-tool-esp'
import { browseLittlefs, isBlankFlash, previewFileContent } from './littlefsBrowse'

describe('littlefsBrowse', () => {
  it('treats all-0xff images as blank', () => {
    expect(isBlankFlash(new Uint8Array(4096).fill(0xff))).toBe(true)
    const dirty = new Uint8Array(4096).fill(0xff)
    dirty[100] = 0x00
    expect(isBlankFlash(dirty)).toBe(false)
  })

  it('lists files from a partitions-tool-esp generated image', () => {
    const image = generate({
      imageSize: 64 * 1024,
      blockSize: 4096,
      readSize: 16,
      progSize: 16,
      source: createDir('root', [
        createFile('boot_count', new Uint8Array([3, 0, 0, 0])),
        createDir('cfg', [createFile('note.txt', new TextEncoder().encode('hi'))]),
      ]),
    })
    const result = browseLittlefs(image, { blockSize: 4096 })
    expect(result).not.toBeNull()
    expect(result!.files.map((f) => f.path).sort()).toEqual(['/boot_count', '/cfg/note.txt'])
    expect([...result!.files.find((f) => f.path === '/boot_count')!.content]).toEqual([3, 0, 0, 0])
    expect(result!.root.children.some((c) => c.kind === 'dir' && c.name === 'cfg')).toBe(true)
  })

  it('returns null for blank flash', () => {
    expect(browseLittlefs(new Uint8Array(8192).fill(0xff))).toBeNull()
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
    // Two dirty 4 KiB sectors as hex ≪ full 1 MiB hex dump.
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
