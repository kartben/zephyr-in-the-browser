/**
 * Dialog that mounts the W25Q image as LittleFS and lists files.
 *
 * Parsing uses `partitions-tool-esp/littlefs` (see `src/lib/littlefsBrowse.ts`).
 */

import { useEffect, useMemo, useState } from 'react'
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

const REFRESH_MS = 400

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

  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const bump = () => {
      last = performance.now()
      setTick((n) => n + 1)
    }
    bump()
    const unsub = chip.subscribe(() => {
      const wait = REFRESH_MS - (performance.now() - last)
      if (wait <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        bump()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        bump()
      }, wait)
    })
    return () => {
      unsub()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip, open])

  const result = useMemo(() => {
    void tick
    return browseLittlefs(chip.memory, { blockSize: chip.decl.sectorSize })
  }, [chip, tick])

  useEffect(() => {
    if (!result || !selected) {
      if (!result) setSelected(null)
      return
    }
    const still = result.files.find((f) => f.path === selected.path)
    if (!still) setSelected(null)
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
  selected,
  onSelect,
  sectorSize,
}: {
  result: LittlefsBrowseResult | null
  selected: LittlefsTreeFile | null
  onSelect: (file: LittlefsTreeFile | null) => void
  sectorSize: number
}) {
  if (!result) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        No LittleFS image yet. Boot the LittleFS sample (or{' '}
        <code className="font-mono text-foreground">fs mount littlefs /lfs</code> in the shell)
        so the guest formats and mounts the partition — then reopen this view.
      </p>
    )
  }

  const { superblock, root, files } = result
  const preview = selected ? previewFileContent(selected.content) : null

  return (
    <div className="flex h-[min(55vh,28rem)] flex-col gap-3">
      <p className="font-mono text-[10px] text-muted-foreground">
        v{(superblock.version >>> 16) & 0xffff}.{superblock.version & 0xffff} ·{' '}
        {superblock.blockCount} × {superblock.blockSize} B blocks · {files.length} file
        {files.length === 1 ? '' : 's'} · erase {sectorSize} B
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
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Folder className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono">{node.name}</span>
      </button>
      {open && (
        <TreeDir node={node} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
      )}
    </li>
  )
}
