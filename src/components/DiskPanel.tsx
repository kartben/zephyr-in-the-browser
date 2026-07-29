/**
 * The virtio-blk disk, as a dock row body.
 *
 * A device row rather than an Instrument: the guest's devicetree really does
 * declare this disk (`virtio,blk` on a virtio-mmio slot), so it belongs in the
 * inventory — and under the `memory` class, beside the SPI NOR, which is both
 * the other storage medium and the panel this one is modelled on. It reuses
 * that panel's parts directly: {@link SectorGrid} for the block map,
 * HexPreview/HexView over a HexBacked facade, and {@link FsBrowserButton} for
 * the filesystem dialog.
 *
 * What differs is where the bytes come from — a stock QEMU device model writing
 * a raw image in the emulator filesystem, which src/hostDisk.ts polls back out
 * — and so what can honestly be said about them: there are no erase counts and
 * no endurance rating behind a block device, only "holds data" or "does not".
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { FsBrowserButton } from '@/components/FsBrowser'
import { HexPreview } from '@/components/HexPreview'
import { HexView, type HexViewRange } from '@/components/HexView'
import { SectorGrid, selectedCellCount } from '@/components/SectorGrid'
import { browseFat } from '@/lib/fatBrowse'
import type { FsBrowseResult } from '@/lib/fsTree'
import { setWindowed } from '@/lib/dockStore'
import * as hostDisk from '@/hostDisk'
import { formatFlashSize } from '@/virtio/devices/flash/model'

/** Capacity and how much of it holds data, for the collapsed row. */
export function DiskBadge() {
  const snap = useSyncExternalStore(hostDisk.subscribe, hostDisk.getSnapshot, hostDisk.getSnapshot)
  if (!snap.available) {
    return <span className="font-mono text-[10px] text-muted-foreground">waiting…</span>
  }
  const usedPct = snap.written.length
    ? Math.round((snap.writtenBlocks / snap.written.length) * 100)
    : 0
  return (
    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
      {usedPct}% · {formatFlashSize(snap.sizeBytes)}
    </span>
  )
}

export function DiskBody({
  dockKey,
  compact = false,
}: {
  /** Row identity, so compact mode can pop the full dump into a window. */
  dockKey?: string
  compact?: boolean
}) {
  const snap = useSyncExternalStore(hostDisk.subscribe, hostDisk.getSnapshot, hostDisk.getSnapshot)

  // A HexBacked facade over MEMFS. Stable for the body's lifetime — it reads
  // through on every access, so it never holds a stale buffer.
  const hexChip = useMemo(() => hostDisk.createDiskHexChip(), [])

  const [hexRange, setHexRange] = useState<HexViewRange | null>(null)
  const onHexViewChange = useCallback((range: HexViewRange) => setHexRange(range), [])

  const browse = useCallback(async (): Promise<FsBrowseResult | null> => {
    // Synchronous parse; the shared dialog wants a promise either way.
    return browseFat(hostDisk.readImage() ?? new Uint8Array(0))
  }, [])

  const labels = useMemo(
    () => ({
      title: 'Disk · FAT',
      description: 'FAT volume on this block disk',
      loading: 'Reading the disk…',
      empty:
        'Nothing formatted yet — the guest mkfs’s the image on its first mount, then this fills in.',
      failed: 'Could not read a FAT volume from this disk image.',
      mountedEmpty: 'Formatted, but empty.',
    }),
    [],
  )

  if (!snap.available) {
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground">
        Waiting for the disk — it appears once the guest starts.
      </p>
    )
  }

  const selectedCount = selectedCellCount(hexRange, snap.blockBytes, snap.written.length)

  return (
    <div className={compact ? 'space-y-1.5 px-3 py-2.5' : 'space-y-2 px-3 py-3'}>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatFlashSize(snap.sizeBytes)} · {snap.writtenBlocks}/{snap.written.length} blocks
        </span>
        {compact && dockKey && (
          <button
            onClick={() => setWindowed(dockKey, true)}
            className="ml-auto text-[10px] text-primary underline-offset-2 hover:underline"
          >
            Hex dump ⧉
          </button>
        )}
        <span className={compact && dockKey ? '' : 'ml-auto'}>
          <FsBrowserButton
            labels={labels}
            browse={browse}
            subscribe={hostDisk.subscribe}
            title="Browse the FAT volume on this disk"
          />
        </span>
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
          <span>
            Blocks · {formatFlashSize(snap.blockBytes)} each
            {compact ? '' : ' · click to show in hex'}
            {selectedCount > 0 ? (
              <span className="text-foreground">
                {' '}
                · {selectedCount === 1 ? '1 in view' : `${selectedCount} in view`}
              </span>
            ) : null}
          </span>
          {/* No wear scale: a block device exposes neither erase counts nor an
              endurance rating, so the map only says whether data is there. */}
          <span className="font-mono tabular-nums">written blocks</span>
        </div>

        <SectorGrid
          count={snap.written.length}
          cellBytes={snap.blockBytes}
          viewRange={hexRange}
          ariaLabel={`Disk block map, ${snap.written.length} blocks, ${snap.writtenBlocks} written${
            selectedCount ? `, ${selectedCount} in hex view` : ''
          }`}
          cell={(i, selected) => {
            const written = snap.written[i] === true
            const addr = i * snap.blockBytes
            return {
              tone: written ? 'bg-sky-500/70' : 'bg-muted',
              label: `block ${i} · 0x${addr.toString(16)} · ${written ? 'has data' : 'zero'}${
                selected ? ' · in hex view' : ''
              }${compact ? '' : ' — click to show in hex'}`,
            }
          }}
        />

        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-[1px] bg-muted" /> zero
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-[1px] bg-sky-500/70" /> data
          </span>
        </div>
      </div>

      {/* HexView pages a window at a time rather than dumping 4 MiB, so it
          needs no height bound of its own — same as the flash card. */}
      {compact ? (
        <HexPreview chip={hexChip} />
      ) : (
        <HexView chip={hexChip} onViewChange={onHexViewChange} />
      )}
    </div>
  )
}
