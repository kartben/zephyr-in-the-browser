/**
 * ZMS viewer for a SPI flash chip: which sectors the store uses, what each key
 * holds, and every older copy still on flash (src/lib/zmsBrowse.ts reads it).
 *
 * Mostly picture: a bar per sector, data filling from its start and entries
 * from its end, with the selected key's versions dotted on the bars. Settings
 * keys show by name; the raw ZMS ids, bookkeeping included, are one toggle
 * away.
 */

import { useEffect, useMemo, useState } from 'react'
import { Binary, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { get as getDeviceTree } from '@/devicetree'
import { previewFileContent } from '@/lib/fsTree'
import { findLittlefsMagic } from '@/lib/littlefsBrowse'
import { cn } from '@/lib/utils'
import {
  findZmsVolumes,
  type ZmsIdRole,
  type ZmsRegion,
  type ZmsVersion,
  type ZmsVolume,
} from '@/lib/zmsBrowse'
import { formatFlashSize, type SpiFlashChip } from '@/virtio/devices/flash/model'

const REFRESH_MS = 500
/** Dots under a sector before they turn into a count. */
const SECTOR_MARKS = 3
/** Version dots in the value pane before the rest become "+N". */
const PANE_MARKS = 12

interface LabelledVolume {
  label: string | null
  volume: ZmsVolume
}

/** The chip's devicetree partitions, labelled, or none when unknown. */
function partitionsFor(cs: number): Array<ZmsRegion & { label: string }> {
  for (const bus of getDeviceTree()?.insights?.spiBuses ?? []) {
    if (!bus.bridged) continue
    const slot = bus.slots.find((s) => s.cs === cs)
    if (slot?.partitions) return slot.partitions
  }
  return []
}

export interface ZmsScan {
  volumes: LabelledVolume[]
  /** Whether LittleFS is on the chip too, so the Filesystem view still applies. */
  littlefs: boolean
}

function scan(chip: SpiFlashChip): ZmsScan {
  const partitions = partitionsFor(chip.cs)
  const volumes = findZmsVolumes(chip.memory, partitions, chip.decl.sectorSize).map((volume) => ({
    volume,
    label: partitions.find((p) => p.offset === volume.offset)?.label ?? null,
  }))
  return {
    volumes,
    littlefs: volumes.length > 0 && findLittlefsMagic(chip.memory) !== null,
  }
}

/** The ZMS stores on a chip, rescanned (coalesced) whenever its bytes change. */
export function useZmsVolumes(chip: SpiFlashChip): ZmsScan {
  const [volumes, setVolumes] = useState(() => scan(chip))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    setVolumes(scan(chip))
    const unsub = chip.subscribe(() => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        setVolumes(scan(chip))
      }, REFRESH_MS)
    })
    return () => {
      unsub()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
  return volumes
}

export function ZmsBrowserButton({
  chip,
  volumes,
}: {
  chip: SpiFlashChip
  volumes: LabelledVolume[]
}) {
  const [open, setOpen] = useState(false)
  // The dialog outlives the store: samples/subsys/kvss/zms ends by erasing it.
  if (volumes.length === 0 && !open) return null
  return (
    <>
      {volumes.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[11px] text-primary-text underline-offset-2 hover:underline"
          title="Browse the ZMS key-value store on this flash"
        >
          ZMS
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          {volumes.length > 0 ? (
            <ZmsDialogBody chip={chip} volumes={volumes} />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{chip.name}</DialogTitle>
                <DialogDescription className="sr-only">The ZMS store was erased</DialogDescription>
              </DialogHeader>
              <p className="px-5 pb-6 text-center font-mono text-[11px] text-muted-foreground">
                Erased
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** One row of the list: a settings key or a raw id. */
interface Item {
  key: string
  label: string
  role?: string
  versions: ZmsVersion[]
  live: ZmsVersion | null
}

function roleWord(role: ZmsIdRole | undefined): string | undefined {
  if (!role) return undefined
  return role.kind === 'head' ? 'list head' : role.kind === 'list' ? 'list' : role.kind
}

function itemsOf(volume: ZmsVolume, raw: boolean): Item[] {
  if (volume.settings && !raw) {
    return volume.settings.keys.map((k) => ({
      key: k.name,
      label: k.name,
      versions: k.versions,
      live: k.live,
    }))
  }
  const roles = volume.settings?.roles
  return [...volume.entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => {
      const role = roles?.get(e.id)
      return {
        key: e.idHex,
        label: e.idHex,
        role: role && role.kind !== 'head' ? `${roleWord(role)} · ${role.key}` : roleWord(role),
        versions: e.versions,
        live: e.live,
      }
    })
}

function ZmsDialogBody({ chip, volumes }: { chip: SpiFlashChip; volumes: LabelledVolume[] }) {
  const [which, setWhich] = useState(0)
  const [raw, setRaw] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pickedAge, setPickedAge] = useState<number | null>(null)

  const current = volumes[Math.min(which, volumes.length - 1)]!
  const { volume } = current
  const items = useMemo(() => itemsOf(volume, raw), [volume, raw])
  const selected = items.find((i) => i.key === selectedKey) ?? items[0] ?? null
  // A version is picked by age, which shifts as the guest writes; fall back to
  // the newest when the picked one is gone.
  const version =
    selected?.versions.find((v) => v.age === pickedAge) ?? selected?.versions[0] ?? null

  const title = [chip.name, current.label].filter(Boolean).join(' · ')

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-baseline gap-2">
          {title}
          <span className="font-mono text-[11px] font-normal text-muted-foreground">
            ZMS · {volume.sectorCount} × {formatFlashSize(volume.sectorSize)}
          </span>
        </DialogTitle>
        <DialogDescription className="sr-only">
          Sectors, keys and value history of the ZMS store on this flash
        </DialogDescription>
      </DialogHeader>
      <div className="flex h-[min(62vh,32rem)] flex-col gap-3 px-5 pb-5">
        {volumes.length > 1 && (
          <div className="flex gap-1" role="tablist">
            {volumes.map((v, i) => (
              <button
                key={v.volume.offset}
                type="button"
                role="tab"
                aria-selected={i === which}
                onClick={() => setWhich(i)}
                className={cn(
                  'rounded px-2 py-0.5 font-mono text-[11px]',
                  i === which
                    ? 'bg-primary/15 text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60',
                )}
              >
                {v.label ?? `0x${v.volume.offset.toString(16)}`}
              </button>
            ))}
          </div>
        )}

        <SectorMap volume={volume} versions={selected?.versions ?? []} current={version} />

        <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="relative min-h-0 overflow-auto rounded-md border border-border bg-background/40 p-1">
            {volume.settings && (
              <button
                type="button"
                onClick={() => setRaw((r) => !r)}
                aria-pressed={raw}
                aria-label="Show raw ZMS ids"
                title={raw ? 'Settings keys' : 'Raw ZMS ids'}
                className={cn(
                  'absolute right-1 top-1 z-10 rounded p-1',
                  raw ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/60',
                )}
              >
                <Binary className="size-3.5" />
              </button>
            )}
            <ul className="space-y-0.5 pr-7">
              {items.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedKey(item.key)
                      setPickedAge(null)
                    }}
                    className={cn(
                      'flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left font-mono text-[11px]',
                      item === selected ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/60',
                      !item.live && 'text-muted-foreground line-through',
                    )}
                  >
                    <span className={cn('truncate', item.role ? 'shrink-0' : 'min-w-0')}>
                      {item.label}
                    </span>
                    {item.role && (
                      <span className="min-w-0 truncate text-muted-foreground">{item.role}</span>
                    )}
                    {item.versions.length > 1 && (
                      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                        ×{item.versions.length}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="min-h-0 overflow-auto rounded-md border border-border bg-background/40 p-3">
            {selected && (
              <ValuePane item={selected} version={version} onPick={(v) => setPickedAge(v.age)} />
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function SectorMap({
  volume,
  versions,
  current,
}: {
  volume: ZmsVolume
  versions: ZmsVersion[]
  current: ZmsVersion | null
}) {
  const S = volume.sectorSize
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1" aria-label="ZMS sectors">
        {volume.sectors.map((sector) => {
          // Newest first, as in the value pane, so the dots read the same way.
          const here = versions.filter((v) => v.sector === sector.index)
          return (
            <div key={sector.index} className="flex min-w-1.5 flex-1 flex-col items-center gap-1">
              <div
                title={`Sector ${sector.index} · ${sector.state}${
                  sector.cycle !== null ? ` · cycle ${sector.cycle}` : ''
                } · ${sector.ates} entries · ${sector.dataBytes} B data`}
                className={cn(
                  'relative h-16 w-full overflow-hidden rounded-sm',
                  sector.state === 'erased' || sector.state === 'spare'
                    ? 'border border-dashed border-border'
                    : 'bg-muted',
                  sector.state === 'open' &&
                    'ring-2 ring-primary ring-offset-1 ring-offset-background',
                  sector.state === 'foreign' && 'bg-destructive/30',
                  current !== null &&
                    here.includes(current) &&
                    'outline outline-1 outline-foreground',
                )}
              >
                <div
                  className="absolute inset-x-0 top-0 bg-sky-500/70"
                  style={{ height: `${(sector.dataBytes / S) * 100}%` }}
                />
                <div
                  className="absolute inset-x-0 bottom-0 bg-amber-400/80"
                  style={{ height: `${(sector.ateBytes / S) * 100}%` }}
                />
              </div>
              <div className="flex min-h-3 items-center justify-center gap-0.5">
                {here.length <= SECTOR_MARKS ? (
                  here.map((v) => (
                    <VersionMark
                      key={v.age}
                      version={v}
                      newest={v.age === versions[0]?.age}
                      current={v === current}
                    />
                  ))
                ) : (
                  <>
                    <VersionMark
                      version={here[0]!}
                      newest={here[0]!.age === versions[0]?.age}
                      current={current !== null && here.includes(current)}
                    />
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {here.length}
                    </span>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-[1px] bg-sky-500/70" /> data
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-[1px] bg-amber-400/80" /> entries
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-[1px] ring-2 ring-primary" /> open
        </span>
      </div>
    </div>
  )
}

/** One version as a dot: filled when it is what a read returns, hollow when superseded. */
function VersionMark({
  version,
  newest,
  current,
}: {
  version: ZmsVersion
  newest: boolean
  current: boolean
}) {
  if (version.deleted) {
    return (
      <X className={cn('size-2 text-destructive', current && 'rounded-full ring-1 ring-primary')} />
    )
  }
  return (
    <span
      className={cn(
        'size-2 rounded-full',
        newest ? 'bg-foreground' : 'border border-muted-foreground',
        current && 'ring-2 ring-primary',
      )}
    />
  )
}

function ValuePane({
  item,
  version,
  onPick,
}: {
  item: Item
  version: ZmsVersion | null
  onPick: (v: ZmsVersion) => void
}) {
  const preview = version && !version.deleted ? previewFileContent(version.bytes) : null
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-foreground">{item.label}</span>
        {version && !version.deleted && (
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {version.len} B
          </span>
        )}
      </div>
      {item.versions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" aria-label="Versions, newest first">
          {item.versions.slice(0, PANE_MARKS).map((v, i) => (
            <button
              key={v.age}
              type="button"
              onClick={() => onPick(v)}
              title={`${i === 0 ? 'newest' : `${i} older`} · sector ${v.sector} · 0x${v.ateAddress.toString(16)}`}
              aria-label={v.deleted ? 'Deleted' : i === 0 ? 'Newest version' : `Version ${i} older`}
              aria-pressed={v === version}
              className={cn(
                'flex size-4 items-center justify-center rounded-full',
                v === version && 'ring-2 ring-primary',
              )}
            >
              {v.deleted ? (
                <X className="size-3 text-destructive" />
              ) : (
                <span
                  className={cn(
                    'size-2.5 rounded-full',
                    i === 0 && item.live ? 'bg-foreground' : 'border border-muted-foreground',
                  )}
                />
              )}
            </button>
          ))}
          {item.versions.length > PANE_MARKS && (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              +{item.versions.length - PANE_MARKS}
            </span>
          )}
        </div>
      )}
      {preview ? (
        <pre
          className={cn(
            'whitespace-pre-wrap break-all rounded bg-muted/40 p-2 text-[11px] leading-relaxed',
            preview.kind === 'hex' && 'font-mono',
          )}
        >
          {preview.text}
        </pre>
      ) : (
        <X className="size-4 text-destructive" aria-label="Deleted" />
      )}
    </div>
  )
}
