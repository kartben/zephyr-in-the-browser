/**
 * Dialog that lists a filesystem and previews the file you pick.
 *
 * Filesystem-agnostic: it takes a `browse` callback returning an
 * {@link FsBrowseResult} and a `subscribe` that tells it when the medium
 * changed. `LittlefsBrowser` supplies littlefs-js over SPI NOR bytes;
 * `FatBrowser` supplies the FAT reader over the virtio-blk image. Everything
 * below — refresh coalescing, selection tracking, the tree, the preview pane —
 * is the same for both.
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
  previewFileContent,
  type FsBrowseResult,
  type FsTreeDir,
  type FsTreeFile,
  type FsTreeNode,
} from '@/lib/fsTree'

const REFRESH_MS = 500

/** What to call the volume, in each state the dialog can be in. */
export interface FsBrowserLabels {
  /** Dialog title, e.g. "w25q80jv · /lfs". */
  title: string
  /** Screen-reader description of the dialog. */
  description: string
  /** Shown while the first browse is in flight. */
  loading: string
  /** Shown before any browse has produced a result. */
  empty: string
  /** Shown when the volume would not mount at all. */
  failed: string
  /** Shown when the volume mounted but holds nothing. */
  mountedEmpty: string
}

export interface FsBrowserProps {
  labels: FsBrowserLabels
  /**
   * Reads the medium and returns its tree. Called on open and on change.
   * `null` means there is no volume there at all (a still-blank image), which
   * reads differently from a mounted-but-empty one.
   */
  browse: () => Promise<FsBrowseResult | null>
  /** Notifies when the underlying bytes changed. Returns an unsubscribe. */
  subscribe: (onChange: () => void) => () => void
}

/** Text button that opens the dialog. Matches the flash panel's affordance. */
export function FsBrowserButton({
  title = 'Browse the filesystem on this volume',
  ...props
}: FsBrowserProps & { title?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] text-primary underline-offset-2 hover:underline"
        title={title}
      >
        Filesystem
      </button>
      <FsBrowserDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  )
}

export function FsBrowserDialog({
  labels,
  browse,
  subscribe,
  open,
  onOpenChange,
}: FsBrowserProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<FsTreeFile | null>(null)
  const [result, setResult] = useState<FsBrowseResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // First open: browse immediately. Later traffic is coalesced so guest
    // write bursts do not stack reads on the shared Asyncify module.
    setTick((n) => n + 1)
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        setTick((n) => n + 1)
      }, REFRESH_MS)
    }
    const unsub = subscribe(schedule)
    return () => {
      unsub()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [subscribe, open])

  useEffect(() => {
    if (!open || tick === 0) return
    let cancelled = false
    setBusy(true)
    void browse()
      .then((next) => {
        if (!cancelled) setResult(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult({
            summary: '',
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
  }, [browse, open, tick])

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
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription className="sr-only">{labels.description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden px-5 pb-5">
          <BrowserBody result={result} busy={busy} selected={selected} onSelect={setSelected} labels={labels} />
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
  labels,
}: {
  result: FsBrowseResult | null
  busy: boolean
  selected: FsTreeFile | null
  onSelect: (file: FsTreeFile | null) => void
  labels: FsBrowserLabels
}) {
  if (busy && !result) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        {labels.loading}
      </p>
    )
  }

  if (!result) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        {labels.empty}
      </p>
    )
  }

  if (result.error && result.files.length === 0) {
    return (
      <div className="space-y-2 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        <p>{labels.failed}</p>
        <p className="font-mono text-[10px] text-foreground/80">{result.error}</p>
      </div>
    )
  }

  const { summary, root, files } = result
  const preview = selected ? previewFileContent(selected.content) : null

  return (
    <div className="flex h-[min(55vh,28rem)] flex-col gap-3">
      <p className="font-mono text-[10px] text-muted-foreground">
        {summary} · {files.length} file{files.length === 1 ? '' : 's'}
        {busy ? ' · refreshing…' : ''}
        {result.error ? ` · ${result.error}` : ''}
      </p>
      <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-2">
        <div className="min-h-0 overflow-auto rounded-md border border-border bg-background/40 p-2">
          <TreeDir
            node={root}
            depth={0}
            selectedPath={selected?.path ?? null}
            onSelect={onSelect}
            emptyLabel={labels.mountedEmpty}
          />
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
  emptyLabel,
}: {
  node: FsTreeDir
  depth: number
  selectedPath: string | null
  onSelect: (file: FsTreeFile) => void
  emptyLabel: string
}) {
  if (node.children.length === 0 && depth === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">{emptyLabel}</p>
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
          emptyLabel={emptyLabel}
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
  emptyLabel,
}: {
  node: FsTreeNode
  depth: number
  selectedPath: string | null
  onSelect: (file: FsTreeFile) => void
  emptyLabel: string
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
        <TreeDir
          node={node}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          emptyLabel={emptyLabel}
        />
      )}
    </li>
  )
}
