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
  Activity,
  BatteryCharging,
  Grid3x3,
  Gamepad2,
  Monitor,
  Network,
  Satellite,
  Terminal,
  Thermometer,
  Tv,
  Vibrate,
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
import { peekSampleDts } from '@/devicetree'
import { loadDocsManifest, sampleDocs } from '@/sampleDocs'
import type { DocsManifest } from '@/sampleDocs'

/**
 * The app picker as a catalog: one card per sample with what it is, what
 * hardware it exercises, and where to read more — the mirrored docs when this
 * deployment carries them, the official page and the source either way — plus
 * the devicetree of the exact build that will boot, in the viewer.
 *
 * Replaces a plain dropdown. Choosing an app is the biggest decision on the
 * page, and a dropdown gave it one truncated line.
 */

/** The panel a sample is primarily about picks its card icon. */
const PANEL_ICONS: Record<PanelKind, LucideIcon> = {
  display: Monitor,
  gnss: Satellite,
  sensor: Thermometer,
  gpio: CircuitBoard,
  keys: Gamepad2,
  buzzer: Vibrate,
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
  trace: Activity,
}

const PANEL_BADGES: Record<PanelKind, string> = {
  display: 'display',
  gnss: 'GNSS',
  sensor: 'sensors',
  gpio: 'GPIO',
  keys: 'keys',
  buzzer: 'buzzer',
  audio: 'audio',
  perf: 'perf',
  net: 'network',
  i2c: 'I2C',
  spi: 'SPI',
  oled: 'OLED',
  auxdisplay: 'LCD',
  led: 'LED',
  pwm: 'PWM',
  dac: 'DAC',
  'fuel-gauge': 'battery',
  trace: 'trace',
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

export function SampleGallery({
  boardId,
  sampleId,
  onSampleChange,
  customImage,
  onLoadElf,
  onClearImage,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
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

        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Zephyr app to boot</DialogTitle>
            <DialogDescription>
              Prebuilt samples for {board.label}. Each card links to its documentation, source
              and the devicetree of the exact image that boots.
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-2.5 overflow-y-auto px-5 pb-4 sm:grid-cols-2">
            {board.samples.map((sample) => (
              <SampleCard
                key={sample.id}
                sample={sample}
                manifest={manifest}
                active={customImage === null && sample.id === sampleId}
                onSelect={() => {
                  setOpen(false)
                  if (customImage !== null || sample.id !== sampleId) onSampleChange(sample.id)
                }}
                onShowDts={() => setDtsSample(sample)}
              />
            ))}
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
        title={`${dtsSample?.label ?? ''} — devicetree (${board.zephyrTarget})`}
        load={loadDts}
      />
    </div>
  )
}

function SampleCard({
  sample,
  manifest,
  active,
  onSelect,
  onShowDts,
}: {
  sample: GuestSample
  manifest: DocsManifest | null
  active: boolean
  onSelect: () => void
  onShowDts: () => void
}) {
  const Icon = sample.primaryPanels?.[0] ? PANEL_ICONS[sample.primaryPanels[0]] : Terminal
  const docs = sampleDocs(sample, manifest)
  // The curated one-liner leads; the mirrored page's paragraph adds depth when
  // this deployment has it and it is not just a rehash of the same sentence.
  const longDescription =
    docs.upstreamDescription && docs.upstreamDescription !== sample.description
      ? docs.upstreamDescription
      : undefined

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    // A card is a big select-me button with real links inside it, so it is a
    // div with role=button rather than a <button> (nested buttons are invalid).
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'group flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-secondary/40 p-3 text-left',
        'transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring',
        active && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="rounded-md border border-border bg-background p-2 text-primary">
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{sample.label}</span>
            {active && (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                current
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {sample.description}
          </p>
        </div>
      </div>

      {longDescription && (
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
          {longDescription}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {(sample.primaryPanels ?? []).map((kind) => (
          <span
            key={kind}
            className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {PANEL_BADGES[kind]}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-0.5">
          {docs.localHref && (
            <CardLink href={docs.localHref} title="Documentation (mirrored here)" onClick={stop}>
              <BookOpen className="size-3.5" aria-hidden />
            </CardLink>
          )}
          {docs.canonicalHref && (
            <CardLink
              href={docs.canonicalHref}
              title="Official docs — docs.zephyrproject.org"
              onClick={stop}
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </CardLink>
          )}
          {docs.sourceHref && (
            <CardLink href={docs.sourceHref} title="Source on GitHub" onClick={stop}>
              <GitBranch className="size-3.5" aria-hidden />
            </CardLink>
          )}
          <button
            type="button"
            title="View the build's devicetree"
            aria-label={`View the ${sample.label} devicetree`}
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
    </div>
  )
}

function CardLink({
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
