/**
 * Dialog that mounts the W25Q image as LittleFS and lists files.
 *
 * Mounts with real littlefs via Dreagonmon littlefs-js
 * (`src/lib/littlefsBrowse.ts`).
 */

import { useEffect, useState } from 'react'
import { ChevronRight, File, Folder } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  browseLittlefs,
  previewFileContent,
  type LittlefsBrowseResult,
  type LittlefsTreeDir,
  type LittlefsTreeFile,
  type LittlefsTreeNode,
} from '@/lib/littlefsBrowse'
import type { SpiFlashChip } from '@/virtio/devices/chips/w25q'

const REFRESH_MS = 500

export function LittlefsBrowserButton({ chip }: { chip: SpiFlashChip }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] text-primary underline-offset-2 hover:underline"
        title="Browse LittleFS on this flash"
      >
        Filesystem
      </button>
      <LittlefsBrowserDialog chip={chip} open={open} onOpenChange={setOpen} />
    </>
  )
}

function LittlefsBrowserDialog({
  chip,
  open,
  onOpenChange,
}: {
  chip: SpiFlashChip
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<LittlefsTreeFile | null>(null)
  const [result, setResult] = useState<LittlefsBrowseResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // First open: browse immediately. Later flash traffic is coalesced so guest
    // SPI bursts do not stack mounts on the shared Asyncify module.
    setTick((n) => n + 1)
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        setTick((n) => n + 1)
      }, REFRESH_MS)
    }
    const unsub = chip.subscribe(schedule)
    return () => {
      unsub()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip, open])

  useEffect(() => {
    if (!open || tick === 0) return
    let cancelled = false
    setBusy(true)
    void browseLittlefs(chip.memory, { blockSize: chip.decl.sectorSize })
      .then((next) => {
        if (!cancelled) setResult(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult({
            superblock: { blockSize: chip.decl.sectorSize, blockCount: 0 },
            files: [],
            root: { kind: 'dir', name: '/', path: '/', children: [] },
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [chip, open, tick])

  useEffect(() => {
    if (!result || !selected) {
      if (!result) setSelected(null)
      return
    }
    const still = result.files.find((f) => f.path === selected.path)
    if (!still) setSelected(null)
    else if (still.content !== selected.content) {
      setSelected({
        kind: 'file',
        name: selected.name,
        path: still.path,
        size: still.size,
        content: still.content,
      })
    }
  }, [result, selected])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{chip.name} · /lfs</DialogTitle>
          <DialogDescription>
            LittleFS on the SPI NOR — same bytes the guest mounts at{' '}
            <code className="font-mono text-foreground">/lfs</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
          <BrowserBody
            result={result}
            busy={busy}
            selected={selected}
            onSelect={setSelected}
            sectorSize={chip.decl.sectorSize}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function BrowserBody({
  result,
  busy,
  selected,
  onSelect,
  sectorSize,
}: {
  result: LittlefsBrowseResult | null
  busy: boolean
  selected: LittlefsTreeFile | null
  onSelect: (file: LittlefsTreeFile | null) => void
  sectorSize: number
}) {
  if (busy && !result) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        Mounting LittleFS…
      </p>
    )
  }

  if (!result) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        No LittleFS image yet. Boot the LittleFS sample (or{' '}
        <code className="font-mono text-foreground">fs mount littlefs /lfs</code> in the shell)
        so the guest formats and mounts the partition — then reopen this view.
      </p>
    )
  }

  if (result.error && result.files.length === 0) {
    return (
      <div className="space-y-2 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        <p>Could not mount LittleFS from this flash image.</p>
        <p className="font-mono text-[10px] text-foreground/80">{result.error}</p>
        <p>
          Guest erase size should match the FS block size (packaged images use 4 KiB via{' '}
          <code className="font-mono text-foreground">SPI_NOR_FLASH_LAYOUT_PAGE_SIZE</code>).
        </p>
      </div>
    )
  }

  const { superblock, root, files } = result
  const preview = selected ? previewFileContent(selected.content) : null

  return (
    <div className="flex h-[min(55vh,28rem)] flex-col gap-3">
      <p className="font-mono text-[10px] text-muted-foreground">
        {superblock.blockCount} × {superblock.blockSize} B blocks · {files.length} file
        {files.length === 1 ? '' : 's'} · erase {sectorSize} B
        {busy ? ' · refreshing…' : ''}
        {result.error ? ` · ${result.error}` : ''}
      </p>
      <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-2">
        <div className="min-h-0 overflow-auto rounded-md border border-border bg-background/40 p-2">
          <TreeDir node={root} depth={0} selectedPath={selected?.path ?? null} onSelect={onSelect} />
        </div>
        <div className="min-h-0 overflow-auto rounded-md border border-border bg-background/40 p-3">
          {!selected && (
            <p className="text-xs text-muted-foreground">Select a file to preview its contents.</p>
          )}
          {selected && preview && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-foreground">{selected.path}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {selected.size} B
                </span>
              </div>
              <pre
                className={cn(
                  'whitespace-pre-wrap break-all rounded bg-muted/40 p-2 text-[11px] leading-relaxed',
                  preview.kind === 'hex' && 'font-mono',
                )}
              >
                {preview.text || '(empty)'}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TreeDir({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: LittlefsTreeDir
  depth: number
  selectedPath: string | null
  onSelect: (file: LittlefsTreeFile) => void
}) {
  if (node.children.length === 0 && depth === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Mounted, but empty.</p>
  }
  return (
    <ul className="space-y-0.5">
      {node.children.map((child) => (
        <TreeNodeRow
          key={child.path}
          node={child}
          depth={depth}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: LittlefsTreeNode
  depth: number
  selectedPath: string | null
  onSelect: (file: LittlefsTreeFile) => void
}) {
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 12 + 4}px` }

  if (node.kind === 'file') {
    const active = selectedPath === node.path
    return (
      <li>
        <button
          type="button"
          style={pad}
          onClick={() => onSelect(node)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px]',
            active ? 'bg-primary/15 text-foreground' : 'text-foreground/90 hover:bg-muted/60',
          )}
        >
          <File className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono">{node.name}</span>
          <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">
            {node.size}
          </span>
        </button>
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        style={pad}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-foreground/90 hover:bg-muted/60"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <Folder className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono">{node.name}</span>
      </button>
      {open && (
        <TreeDir node={node} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
      )}
    </li>
  )
}
