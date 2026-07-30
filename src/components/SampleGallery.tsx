import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ExternalLink,
  FileUp,
  GitBranch,
  GraduationCap,
  Search,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { registerCommand } from '@/lib/commands'
import { cn } from '@/lib/utils'
import { getBoard, getSample } from '@/boards'
import type { GuestSample, PanelKind } from '@/boards'
import { isGuided } from '@/tours/guided'
import { loadDocsManifest, sampleDocs } from '@/sampleDocs'
import type { DocsManifest, SampleDocs } from '@/sampleDocs'

/**
 * Compact app picker: one row per sample. A global Tracing switch filters to
 * builds with CTF tracing (and selects that twin on click) instead of listing
 * base/_trace pairs twice. Tags come from primary panels; docs and source are
 * the only outbound links.
 */

const PANEL_TAGS: Record<PanelKind, string> = {
  display: 'display',
  gnss: 'GNSS',
  sensor: 'sensors',
  gpio: 'GPIO',
  keys: 'keys',
  buzzer: 'buzzer',
  stepper: 'stepper',
  audio: 'audio',
  perf: 'perf',
  net: 'network',
  i2c: 'I²C',
  spi: 'SPI',
  oled: 'OLED',
  auxdisplay: 'text',
  led: 'LED',
  pwm: 'PWM',
  dac: 'DAC',
  disk: 'disk',
  'fuel-gauge': 'battery',
  can: 'CAN',
  bluetooth: 'Bluetooth',
  trace: 'trace',
  debug: 'debug',
}

/** Panels the traced twin adds; hide them on the shared tag row. */
const TRACE_TWIN_PANELS = new Set<PanelKind>(['trace', 'debug'])

interface Props {
  boardId: string
  sampleId: string
  onSampleChange: (id: string) => void
  /** Filename of the user-supplied image in use, if any. */
  customImage: string | null
  onLoadElf: (file: File) => void
  onClearImage: () => void
}

/** One gallery row: base sample plus optional CTF-traced twin. */
export interface SampleGroup {
  base: GuestSample
  traced: GuestSample | null
  docs: SampleDocs
}

export function buildSampleGroups(
  samples: GuestSample[],
  manifest: DocsManifest | null,
): SampleGroup[] {
  const byId = new Map(samples.map((s) => [s.id, s]))
  const groups: SampleGroup[] = []

  for (const sample of samples) {
    if (sample.tracedFrom) continue
    const traced = byId.get(`${sample.id}_trace`) ?? null
    // Only treat an explicit twin (tracedFrom → this base) as the paired build.
    const twin =
      traced?.tracedFrom === sample.id
        ? traced
        : samples.find((s) => s.tracedFrom === sample.id) ?? null
    groups.push({
      base: sample,
      traced: twin,
      docs: sampleDocs(sample, manifest),
    })
  }

  return groups.sort((a, b) =>
    a.docs.title.localeCompare(b.docs.title, undefined, { sensitivity: 'base' }),
  )
}

/** Tags shown on the row: panels the sample is about, not the twin's extras. */
export function sampleTags(group: SampleGroup): PanelKind[] {
  const panels = group.base.primaryPanels ?? []
  if (!group.traced) return panels
  return panels.filter((kind) => !TRACE_TWIN_PANELS.has(kind))
}

/** True when the sample has a CTF twin or embeds tracing itself. */
export function groupHasTracing(group: SampleGroup): boolean {
  return (
    group.traced !== null || (group.base.primaryPanels?.includes('trace') ?? false)
  )
}

/** Which artifact a row click should boot under the current Tracing filter. */
export function selectSampleId(group: SampleGroup, tracing: boolean): string {
  if (tracing && group.traced) return group.traced.id
  return group.base.id
}

function groupHaystack(group: SampleGroup): string {
  return [
    group.docs.title,
    group.docs.description,
    group.base.label,
    group.base.description,
    group.base.id,
    group.base.zephyrSample,
    ...(group.traced
      ? [group.traced.id, group.traced.label, 'traced', 'tracing', 'ctf']
      : []),
    ...sampleTags(group).map((kind) => PANEL_TAGS[kind]),
    ...(group.base.primaryPanels?.includes('trace') ? ['traced', 'tracing', 'ctf'] : []),
  ]
    .join(' ')
    .toLowerCase()
}

export function matchesGroupQuery(group: SampleGroup, query: string): boolean {
  if (!query) return true
  const haystack = groupHaystack(group)
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token))
}

export function SampleGallery({
  boardId,
  sampleId,
  onSampleChange,
  customImage,
  onLoadElf,
  onClearImage,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [tracing, setTracing] = useState(false)
  const [manifest, setManifest] = useState<DocsManifest | null>(null)
  const board = getBoard(boardId)

  const groups = useMemo(
    () => buildSampleGroups(board.samples, manifest),
    [board.samples, manifest],
  )
  const boardHasTracing = useMemo(
    () => groups.some((group) => group.traced !== null),
    [groups],
  )

  useEffect(() => registerCommand('open-samples', () => setOpen(true)), [])

  // The manifest is gallery furniture, not boot data: fetch it lazily on the
  // first open, and tolerate its absence (dev checkouts have no /docs).
  useEffect(() => {
    if (!open) return
    let stale = false
    void loadDocsManifest().then((m) => {
      if (!stale && m) setManifest(m)
    })
    return () => {
      stale = true
    }
  }, [open])

  // Focus search on open; clear the query on close. If the running app is a
  // traced twin, seed the Tracing filter so the list matches what is booted.
  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const current = getSample(board, sampleId)
    if (current.tracedFrom) setTracing(true)
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, board, sampleId])

  const catalog = groups.filter((group) => {
    if (tracing && !groupHasTracing(group)) return false
    return matchesGroupQuery(group, query)
  })

  const select = (id: string) => {
    setOpen(false)
    if (customImage !== null || id !== sampleId) onSampleChange(id)
  }

  return (
    <div className="flex min-w-0 shrink items-center gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label="Choose the Zephyr app to boot"
            className={cn(
              'flex h-8 min-w-0 items-center gap-2 rounded-md border border-border bg-transparent px-2.5 text-sm',
              'transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background',
            )}
          >
            <span className={cn('truncate', customImage && 'font-mono text-[11px]')}>
              {customImage ?? getSample(board, sampleId).label}
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
          </button>
        </DialogTrigger>

        <DialogContent className="h-[min(85vh,40rem)] max-w-xl">
          <DialogHeader>
            <DialogTitle>Zephyr app to boot</DialogTitle>
            <DialogDescription>Prebuilt samples for {board.label}.</DialogDescription>
          </DialogHeader>

          <div className="flex shrink-0 items-center gap-3 px-5 pb-3">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search samples</span>
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search samples…"
                autoComplete="off"
                className={cn(
                  'h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm',
                  'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring',
                )}
              />
            </label>
            {boardHasTracing && (
              <TracingFilter on={tracing} onChange={setTracing} />
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-1">
            {catalog.length === 0 ? (
              <p className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                {tracing && !query.trim()
                  ? 'No samples with tracing on this board.'
                  : tracing
                    ? `No traced samples match “${query.trim()}”.`
                    : `No samples match “${query.trim()}”.`}
              </p>
            ) : (
              catalog.map((group) => (
                <SampleGroupRow
                  key={group.base.id}
                  group={group}
                  sampleId={sampleId}
                  customImage={customImage}
                  tracing={tracing}
                  onSelect={select}
                />
              ))
            )}
          </div>

          <DialogFooter className="justify-between">
            <span className="text-[11px] text-muted-foreground">
              Or bring your own build. Any Zephyr ELF for this board boots as-is.
            </span>
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <FileUp aria-hidden />
              Load your own ELF…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {customImage && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="Go back to a built-in app"
          title="Go back to a built-in app"
          onClick={onClearImage}
        >
          <X className="size-3.5" />
        </Button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".elf,application/x-elf,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Reset so picking the same file twice still fires a change event.
          e.target.value = ''
          if (file) {
            setOpen(false)
            onLoadElf(file)
          }
        }}
      />
    </div>
  )
}

function SampleGroupRow({
  group,
  sampleId,
  customImage,
  tracing,
  onSelect,
}: {
  group: SampleGroup
  sampleId: string
  customImage: string | null
  tracing: boolean
  onSelect: (id: string) => void
}) {
  const { base, traced, docs } = group
  const tags = sampleTags(group)
  const guided = isGuided(base)
  const builtinTraced =
    !traced && (base.primaryPanels?.includes('trace') ?? false)
  const activeBase = customImage === null && sampleId === base.id
  const activeTraced = customImage === null && traced !== null && sampleId === traced.id
  const active = activeBase || activeTraced
  const bootId = selectSampleId(group, tracing)

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    // A row is a select-me control with real links inside it, so it is a div
    // with role=button rather than a <button> (nested buttons are invalid).
    <div
      role="button"
      aria-pressed={active}
      tabIndex={0}
      title={docs.description}
      onClick={() => onSelect(bootId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(bootId)
        }
      }}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left',
        'transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring',
        active && 'bg-primary/10 ring-1 ring-primary',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium leading-5">{docs.title}</span>
          {guided && (
            <span
              className="flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              title="Carries a guided tour: it stops and explains itself as it runs"
            >
              <GraduationCap className="size-2.5" aria-hidden />
              guided
            </span>
          )}
          {builtinTraced && (
            <span
              className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
              title="This sample embeds tracing in its own configuration"
            >
              tracing
            </span>
          )}
        </div>
        {tags.length > 0 && (
          <div className="mt-1 flex min-w-0 flex-wrap gap-1">
            {tags.map((kind) => (
              <span
                key={kind}
                className="rounded bg-secondary px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
              >
                {PANEL_TAGS[kind]}
              </span>
            ))}
          </div>
        )}
      </div>

      <span className="flex shrink-0 items-center gap-0.5 self-center">
        {docs.canonicalHref && (
          <RowLink
            href={docs.canonicalHref}
            title="Official docs (docs.zephyrproject.org)"
            onClick={stop}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            <span className="sr-only">Docs</span>
          </RowLink>
        )}
        {docs.sourceHref && (
          <RowLink href={docs.sourceHref} title="Source on GitHub" onClick={stop}>
            <GitBranch className="size-3.5" aria-hidden />
            <span className="sr-only">Source</span>
          </RowLink>
        )}
      </span>
    </div>
  )
}

/** Gallery-wide filter: only samples with a tracing build, and boot that build. */
function TracingFilter({
  on,
  onChange,
}: {
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-xs text-muted-foreground" aria-hidden>
        Tracing
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Tracing"
        title={
          on
            ? 'Showing samples with tracing. Turn off to see every sample.'
            : 'Show only samples with a tracing build. Choosing one opens Trace and Debug.'
        }
        onClick={() => onChange(!on)}
        className={cn(
          'relative h-4 w-7 shrink-0 rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          on ? 'bg-amber-500' : 'bg-border hover:bg-muted-foreground/40',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 size-3 rounded-full bg-background shadow-sm transition-transform',
            on ? 'left-3.5' : 'left-0.5',
          )}
        />
      </button>
    </span>
  )
}

function RowLink({
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      target="_blank"
      rel="noreferrer"
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      {...props}
    >
      {children}
    </a>
  )
}
