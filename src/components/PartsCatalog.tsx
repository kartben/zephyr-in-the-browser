/**
 * Catalog of every simulated silicon part the page can attach — identity cards
 * with datasheet and Zephyr binding links.
 *
 * Mirrors {@link SampleGallery}: choosing what runs is one decision; knowing
 * which chips the browser models is another, and a plain attach dropdown never
 * showed either.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  BatteryCharging,
  BookOpen,
  Cable,
  Clock,
  ExternalLink,
  FileText,
  Grid3x3,
  MemoryStick,
  Monitor,
  RotateCw,
  Search,
  Thermometer,
  Tv,
  Waves,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { PartIdentityStrip } from '@/components/PartIdentityStrip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  PARTS,
  PART_KIND_LABELS,
  type PartIdentity,
} from '@/virtio/devices/parts'

const KIND_ICONS: Record<PartIdentity['kind'], LucideIcon> = {
  sensor: Thermometer,
  eeprom: MemoryStick,
  display: Tv,
  auxdisplay: Monitor,
  led: Grid3x3,
  pwm: Activity,
  dac: Waves,
  'fuel-gauge': BatteryCharging,
  rtc: Clock,
  flash: MemoryStick,
  stepper: RotateCw,
}

function formatAddress(part: PartIdentity): string {
  if (part.addressKind === 'spi-cs') return `CS${part.defaultAddress}`
  const primary = `0x${part.defaultAddress.toString(16)}`
  if (part.secondaryAddress === undefined) return primary
  const secondary = `0x${part.secondaryAddress.toString(16)}`
  return `${primary} + ${secondary}${part.secondaryLabel ? ` (${part.secondaryLabel})` : ''}`
}

function matchesQuery(part: PartIdentity, query: string): boolean {
  if (!query) return true
  const haystack = [
    part.label,
    part.manufacturer,
    part.part,
    part.compatible,
    part.summary,
    part.bus,
    PART_KIND_LABELS[part.kind],
    part.id,
  ]
    .join(' ')
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token))
}

export function PartsCatalog() {
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const catalog = useMemo(
    () => PARTS.filter((part) => matchesQuery(part, query)),
    [query],
  )

  const grouped = useMemo(() => {
    const map = new Map<PartIdentity['kind'], PartIdentity[]>()
    for (const part of catalog) {
      const list = map.get(part.kind) ?? []
      list.push(part)
      map.set(part.kind, list)
    }
    return [...map.entries()]
  }, [catalog])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label="Supported parts catalog"
          title="Supported parts"
        >
          <Cable className="size-3.5" aria-hidden />
        </Button>
      </DialogTrigger>

      <DialogContent className="h-[min(85vh,42rem)] max-w-xl">
        <DialogHeader>
          <DialogTitle>Supported parts</DialogTitle>
          <DialogDescription>
            Simulated chips the browser can attach on virtio-i2c / virtio-spi —
            each with manufacturer, Zephyr compatible, and datasheet when one is
            linkable.
          </DialogDescription>
        </DialogHeader>

        <div className="shrink-0 px-5 pb-3">
          <label className="relative block">
            <span className="sr-only">Search parts</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by part, vendor, compatible…"
              autoComplete="off"
              className={cn(
                'h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm',
                'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring',
              )}
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-2">
          {catalog.length === 0 ? (
            <p className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
              No parts match “{query.trim()}”.
            </p>
          ) : (
            grouped.map(([kind, parts]) => (
              <section key={kind} className="mb-3">
                <h3 className="sticky top-0 z-10 bg-card/95 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {PART_KIND_LABELS[kind]}
                  <span className="ml-1.5 font-normal tabular-nums opacity-70">{parts.length}</span>
                </h3>
                <ul className="space-y-1">
                  {parts.map((part) => (
                    <li key={part.id}>
                      <PartCard part={part} />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PartCard({ part }: { part: PartIdentity }) {
  const Icon = KIND_ICONS[part.kind]

  return (
    <article className="flex items-start gap-2.5 rounded-md px-2.5 py-2.5 hover:bg-secondary/50">
      <div className="mt-0.5 rounded border border-border bg-secondary/60 p-1.5 text-primary">
        <Icon className="size-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h4 className="text-sm font-medium leading-5">{part.part}</h4>
          <span className="text-[11px] text-muted-foreground">{part.label}</span>
        </div>
        <PartIdentityStrip part={part} links={false} />
        <p className="font-mono text-[10px] text-muted-foreground/90">
          {part.bus.toUpperCase()} · default {formatAddress(part)}
        </p>
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {part.datasheetUrl && (
            <CatalogLink href={part.datasheetUrl} label="Datasheet" icon={FileText} />
          )}
          {part.bindingUrl && (
            <CatalogLink href={part.bindingUrl} label="Zephyr binding" icon={BookOpen} />
          )}
        </div>
      </div>
    </article>
  )
}

function CatalogLink({
  href,
  label,
  icon: Icon,
}: {
  href: string
  label: string
  icon: LucideIcon
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <Icon className="size-3" aria-hidden />
      {label}
      <ExternalLink className="size-2.5 opacity-60" aria-hidden />
    </a>
  )
}
