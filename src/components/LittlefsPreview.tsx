/**
 * Screenshot / demo surface for the SPI NOR LittleFS browser.
 *
 * Open with `?preview=littlefs`. Seeds a real littlefs v2 image into a W25Q
 * stub and opens the same SpiFlashBody + Filesystem dialog the dock uses.
 */

import { useEffect, useState } from 'react'
import { HardDrive } from 'lucide-react'
import {
  LFS,
  LFS_O_CREAT,
  LFS_O_TRUNC,
  LFS_O_WRONLY,
  MemoryBlockDevice,
} from '@/vendor/littlefs-js/lfs_js.js'
import { SpiFlashBody } from '@/components/MemoryCard'
import { createW25q, W25Q_DEFAULT_SIZE } from '@/virtio/devices/chips/w25q'

async function seedFlashImage(): Promise<Uint8Array> {
  const block = 4096
  const count = W25Q_DEFAULT_SIZE / block
  const bdev = new MemoryBlockDevice(block, count)
  bdev.read_size = 16
  bdev.prog_size = 16
  const lfs = new LFS(bdev, 512)
  await lfs.format()
  await lfs.mount()

  const write = async (path: string, data: Uint8Array) => {
    const file = await lfs.open(path, LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC)
    if (typeof file === 'number') throw new Error(`open ${path} → ${file}`)
    await file.write(data)
    await file.close()
  }

  await write('/boot_count', new Uint8Array([7, 0, 0, 0]))
  await lfs.mkdir('/cfg')
  await write('/cfg/note.txt', new TextEncoder().encode('hello from /lfs\n'))
  await write('/cfg/banner', new TextEncoder().encode('Zephyr LittleFS\n'))
  await write(
    '/README',
    new TextEncoder().encode('Persists across reload via sparse W25Q sectors.\n'),
  )
  await lfs.unmount()

  const image = new Uint8Array(W25Q_DEFAULT_SIZE).fill(0xff)
  for (let i = 0; i < bdev._storage.length; i++) {
    const sector = bdev._storage[i]
    if (sector) image.set(sector, i * block)
  }
  return image
}

const flash = createW25q({ cs: 0, size: W25Q_DEFAULT_SIZE })
let seeded = false

export function LittlefsPreview() {
  const [ready, setReady] = useState(seeded)
  const [openOnce] = useState(true)

  useEffect(() => {
    if (seeded) return
    let cancelled = false
    void seedFlashImage().then((image) => {
      if (cancelled) return
      flash.memory.set(image)
      flash.poke(0, flash.memory[0]!)
      seeded = true
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!openOnce || !ready) return
    const id = window.setTimeout(() => {
      const link = [...document.querySelectorAll('button')].find((b) =>
        /^Filesystem$/i.test((b.textContent || '').trim()),
      )
      link?.click()
      window.setTimeout(() => {
        const fileBtn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
          (b.textContent || '').includes('boot_count'),
        ) as HTMLButtonElement | undefined
        fileBtn?.click()
      }, 500)
    }, 400)
    return () => window.clearTimeout(id)
  }, [openOnce, ready])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(ellipse at 20% 0%, oklch(0.35 0.06 200 / 0.35), transparent 55%), radial-gradient(ellipse at 80% 100%, oklch(0.3 0.04 250 / 0.25), transparent 50%)',
        }}
      />
      <div className="relative mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10">
        <header className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Zephyr in the Browser
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">SPI NOR · LittleFS</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            The W25Q card’s hex dump plus a{' '}
            <span className="text-foreground">Filesystem</span> dialog that mounts the same
            bytes with real littlefs (Dreagonmon littlefs-js).
          </p>
        </header>

        <section
          id="shot-flash-card"
          className="w-[28rem] overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <HardDrive className="size-3.5 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold tracking-tight">{flash.name}</div>
              <div className="font-mono text-[10px] text-muted-foreground">
                virtio_spi0 · CS{flash.cs} · jedec,spi-nor
              </div>
            </div>
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
              memory
            </span>
          </header>
          <SpiFlashBody chip={flash} />
        </section>
      </div>
    </div>
  )
}
