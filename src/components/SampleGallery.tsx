import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  Cable,
  ChevronDown,
  CircuitBoard,
  ExternalLink,
  FileCode2,
  FileUp,
  Gauge,
  GitBranch,
  GraduationCap,
  Activity,
  BatteryCharging,
  Bug,
  Grid3x3,
  Gamepad2,
  Monitor,
  Network,
  Satellite,
  Search,
  Terminal,
  Thermometer,
  Tv,
  Vibrate,
  RotateCw,
  Volume2,
  Waves,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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
import { DtsViewer } from '@/components/DtsViewer'
import { cn } from '@/lib/utils'
import { getBoard, getSample, sampleDtsAsset } from '@/boards'
import type { GuestSample, PanelKind } from '@/boards'
import { isGuided } from '@/annotations/guided'
import { peekSampleDts } from '@/devicetree'
import { loadDocsManifest, sampleDocs } from '@/sampleDocs'
import type { DocsManifest, SampleDocs } from '@/sampleDocs'

/**
 * The app picker as a compact, searchable catalog: one row per sample with
 * title and description (from the mirrored Zephyr docs when available), what
 * hardware it exercises, and where to read more — plus the devicetree of the
 * exact build that will boot.
 *
 * Replaces a plain dropdown. Choosing an app is the biggest decision on the
 * page, and a dropdown gave it one truncated line.
 */

/** The panel a sample is primarily about picks its row icon. */
const PANEL_ICONS: Record<PanelKind, LucideIcon> = {
  display: Monitor,
  gnss: Satellite,
  sensor: Thermometer,
  gpio: CircuitBoard,
  keys: Gamepad2,
  buzzer: Vibrate,
  stepper: RotateCw,
  audio: Volume2,
  perf: Gauge,
  net: Network,
  i2c: Cable,
  spi: Cable,
  oled: Tv,
  auxdisplay: Monitor,
  led: Grid3x3,
  pwm: Activity,
  dac: Waves,
  'fuel-gauge': BatteryCharging,
  can: Network,
  trace: Activity,
  debug: Bug,
}

const PANEL_BADGES: Record<PanelKind, string> = {
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
  i2c: 'I2C',
  spi: 'SPI',
  oled: 'OLED',
  auxdisplay: 'text',
  led: 'LED',
  pwm: 'PWM',
  dac: 'DAC',
  'fuel-gauge': 'battery',
  can: 'CAN',
  trace: 'trace',
  debug: 'debug',
}

interface Props {
  boardId: string
  sampleId: string
  onSampleChange: (id: string) => void
  /** Filename of the user-supplied image in use, if any. */
  customImage: string | null
  onLoadElf: (file: File) => void
  onClearImage: () => void
}

interface CatalogEntry {
  sample: GuestSample
  docs: SampleDocs
}

function buildCatalog(samples: GuestSample[], manifest: DocsManifest | null): CatalogEntry[] {
  return samples
    .map((sample) => ({ sample, docs: sampleDocs(sample, manifest) }))
    .sort((a, b) => {
      // Keep base + traced twins adjacent: sort by base id, then untraced first.
      const aBase = a.sample.tracedFrom ?? a.sample.id
      const bBase = b.sample.tracedFrom ?? b.sample.id
      const aTitle = sampleDocs(
        samples.find((s) => s.id === aBase) ?? a.sample,
        manifest,
      ).title
      const bTitle = sampleDocs(
        samples.find((s) => s.id === bBase) ?? b.sample,
        manifest,
      ).title
      const byTitle = aTitle.localeCompare(bTitle, undefined, { sensitivity: 'base' })
      if (byTitle !== 0) return byTitle
      return (a.sample.tracedFrom ? 1 : 0) - (b.sample.tracedFrom ? 1 : 0)
    })
}

function matchesQuery(entry: CatalogEntry, query: string): boolean {
  if (!query) return true
  const haystack = [
    entry.docs.title,
    entry.docs.description,
    entry.sample.label,
    entry.sample.description,
    entry.sample.id,
    entry.sample.zephyrSample,
    ...(entry.sample.tracedFrom ? ['traced', 'tracing', 'ctf'] : []),
    ...(entry.sample.primaryPanels ?? []).map((kind) => PANEL_BADGES[kind]),
  ]
    .join(' ')
    .toLowerCase()
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
  const [manifest, setManifest] = useState<DocsManifest | null>(null)
  const [dtsSample, setDtsSample] = useState<GuestSample | null>(null)
  const board = getBoard(boardId)

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

  // Focus the search field when the dialog opens; clear it when it closes.
  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const catalog = buildCatalog(board.samples, manifest).filter((entry) => matchesQuery(entry, query))

  const dtsDocs = dtsSample ? sampleDocs(dtsSample, manifest) : null

  const loadDts = useCallback(() => {
    if (!dtsSample) return Promise.resolve(null)
    return peekSampleDts(
      `${import.meta.env.BASE_URL}qemu/${sampleDtsAsset(board, dtsSample.id)}`,
    )
  }, [board, dtsSample])

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
            <DialogDescription>
              Prebuilt samples for {board.label}, sorted A–Z. Titles and descriptions come from
              the Zephyr docs when this deployment carries them.
            </DialogDescription>
          </DialogHeader>

          <div className="shrink-0 px-5 pb-3">
            <label className="relative block">
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
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-1">
            {catalog.length === 0 ? (
              <p className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                No samples match “{query.trim()}”.
              </p>
            ) : (
              catalog.map(({ sample, docs }) => (
                <SampleRow
                  key={sample.id}
                  sample={sample}
                  docs={docs}
                  active={customImage === null && sample.id === sampleId}
                  onSelect={() => {
                    setOpen(false)
                    if (customImage !== null || sample.id !== sampleId) onSampleChange(sample.id)
                  }}
                  onShowDts={() => setDtsSample(sample)}
                />
              ))
            )}
          </div>

          <DialogFooter className="justify-between">
            <span className="text-[11px] text-muted-foreground">
              Or bring your own build — any Zephyr ELF for this machine boots as-is.
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

      <DtsViewer
        open={dtsSample !== null}
        onOpenChange={(o) => {
          if (!o) setDtsSample(null)
        }}
        title={`${dtsDocs?.title ?? dtsSample?.label ?? ''} — devicetree (${board.zephyrTarget})`}
        load={loadDts}
      />
    </div>
  )
}

function SampleRow({
  sample,
  docs,
  active,
  onSelect,
  onShowDts,
}: {
  sample: GuestSample
  docs: SampleDocs
  active: boolean
  onSelect: () => void
  onShowDts: () => void
}) {
  const Icon = sample.primaryPanels?.[0] ? PANEL_ICONS[sample.primaryPanels[0]] : Terminal
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    // A row is a select-me control with real links inside it, so it is a div
    // with role=button rather than a <button> (nested buttons are invalid).
    <div
      role="button"
      aria-pressed={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'group flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left',
        'transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring',
        active && 'bg-primary/10 ring-1 ring-primary',
      )}
    >
      <div className="mt-0.5 rounded border border-border bg-secondary/60 p-1.5 text-primary">
        <Icon className="size-3.5" aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium leading-5">{docs.title}</span>
          {(sample.tracedFrom || (sample.primaryPanels?.includes('trace') ?? false)) && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
              title={
                sample.tracedFrom
                  ? 'Built with CTF tracing (browser-tracing) and thread debug info'
                  : 'This sample embeds CTF tracing in its own configuration'
              }
            >
              <Activity className="size-2.5" aria-hidden />
              traced
            </span>
          )}
          {isGuided(sample) && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              title="Stops and explains itself as it runs"
            >
              <GraduationCap className="size-2.5" aria-hidden />
              guided
            </span>
          )}
          {active && (
            <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              current
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {docs.description}
        </p>
        {(sample.primaryPanels?.length ?? 0) > 0 && (
          <p className="mt-1 truncate text-[10px] leading-none text-muted-foreground/80">
            {sample.primaryPanels!.map((kind) => PANEL_BADGES[kind]).join(' · ')}
          </p>
        )}
      </div>

      <span className="flex shrink-0 items-center gap-0.5 pt-0.5">
        {docs.localHref && (
          <RowLink href={docs.localHref} title="Documentation (mirrored here)" onClick={stop}>
            <BookOpen className="size-3.5" aria-hidden />
          </RowLink>
        )}
        {docs.canonicalHref && (
          <RowLink
            href={docs.canonicalHref}
            title="Official docs — docs.zephyrproject.org"
            onClick={stop}
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </RowLink>
        )}
        {docs.sourceHref && (
          <RowLink href={docs.sourceHref} title="Source on GitHub" onClick={stop}>
            <GitBranch className="size-3.5" aria-hidden />
          </RowLink>
        )}
        <button
          type="button"
          title="View the build's devicetree"
          aria-label={`View the ${docs.title} devicetree`}
          onClick={(e) => {
            e.stopPropagation()
            onShowDts()
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <FileCode2 className="size-3.5" aria-hidden />
        </button>
      </span>
    </div>
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
