/**
 * Screenshot / demo surface for the SPI NOR LittleFS browser.
 *
 * Open with `?preview=littlefs`. Seeds a real littlefs v2 image into a W25Q
 * stub and opens the same SpiFlashBody + Filesystem dialog the dock uses.
 */

import { useEffect, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { generate } from 'partitions-tool-esp/littlefs'
import { createDir, createFile } from 'partitions-tool-esp'
import { SpiFlashBody } from '@/components/MemoryCard'
import { createW25q, W25Q_DEFAULT_SIZE } from '@/virtio/devices/chips/w25q'

function seedFlash() {
  const chip = createW25q({ cs: 0, size: W25Q_DEFAULT_SIZE })
  const image = generate({
    imageSize: W25Q_DEFAULT_SIZE,
    blockSize: 4096,
    readSize: 16,
    progSize: 16,
    source: createDir('root', [
      createFile('boot_count', new Uint8Array([7, 0, 0, 0])),
      createDir('cfg', [
        createFile('note.txt', new TextEncoder().encode('hello from /lfs\n')),
        createFile('banner', new TextEncoder().encode('Zephyr LittleFS\n')),
      ]),
      createFile('README', new TextEncoder().encode('Persists across reload via sparse W25Q sectors.\n')),
    ]),
  })
  chip.memory.set(image.subarray(0, Math.min(image.length, chip.memory.length)))
  // Nudge subscribers so HexPreview / dialog refresh once.
  chip.poke(0, chip.memory[0]!)
  return chip
}

const flash = seedFlash()

export function LittlefsPreview() {
  const [openOnce] = useState(true)

  useEffect(() => {
    if (!openOnce) return
    const id = window.setTimeout(() => {
      const link = [...document.querySelectorAll('button')].find((b) =>
        /^Filesystem$/i.test((b.textContent || '').trim()),
      )
      link?.click()
      window.setTimeout(() => {
        const fileBtn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
          (b.textContent || '').includes('boot_count'),
        )
        fileBtn?.click()
      }, 350)
    }, 300)
    return () => window.clearTimeout(id)
  }, [openOnce])

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
            bytes with <code className="font-mono text-foreground">partitions-tool-esp/littlefs</code>.
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
