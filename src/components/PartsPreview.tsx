/**
 * Standalone preview of the parts identity UI for screenshots.
 * Open with `?preview=parts`.
 */

import { useState } from 'react'
import { BookOpen, Cable, ExternalLink, FileText, Thermometer } from 'lucide-react'
import { PartsCatalog } from '@/components/PartsCatalog'
import { PartIdentityStrip } from '@/components/PartIdentityStrip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PARTS, PART_KIND_LABELS, type PartIdentity } from '@/virtio/devices/parts'

function formatAddress(part: PartIdentity): string {
  if (part.addressKind === 'spi-cs') return `CS${part.defaultAddress}`
  const primary = `0x${part.defaultAddress.toString(16)}`
  if (part.secondaryAddress === undefined) return primary
  return `${primary} + 0x${part.secondaryAddress.toString(16)}`
}

function CatalogLink({ href, label, icon: Icon }: {
  href: string
  label: string
  icon: typeof FileText
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

function IdentityCard({ part }: { part: PartIdentity }) {
  return (
    <article className="flex items-start gap-2.5 rounded-md px-2.5 py-2.5 hover:bg-secondary/50">
      <div className="mt-0.5 rounded border border-border bg-secondary/60 p-1.5 text-primary">
        <Thermometer className="size-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h4 className="text-sm font-medium leading-5">{part.part}</h4>
          <span className="text-[11px] text-muted-foreground">{PART_KIND_LABELS[part.kind]}</span>
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

export function PartsPreview() {
  const [open, setOpen] = useState(true)
  const featured = PARTS.filter((p) =>
    ['tmp112', 'adxl345', 'max17048', 'pca9685', 'w25q'].includes(p.id),
  )
  const tmp112 = PARTS.find((p) => p.id === 'tmp112')!

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex h-14 items-center gap-3 border-b border-border px-5">
        <Cable className="size-4 text-primary" aria-hidden />
        <h1 className="text-sm font-semibold">Parts identity preview</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Open catalog
          </Button>
          <PartsCatalog />
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-8 p-8 lg:grid-cols-2">
        <section className="space-y-3" data-preview="dock-strip">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Dock identity strip
          </h2>
          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Thermometer className="size-3.5 text-primary" aria-hidden />
              <span className="text-xs font-medium">TMP112 temperature</span>
              <span className="font-mono text-[10px] text-muted-foreground">ti,tmp112</span>
            </div>
            <div className="border-b border-border/40 px-2 py-1.5">
              <PartIdentityStrip partId="tmp112" compact />
            </div>
            <div className="space-y-2 px-3 py-3 text-[11px] text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>Temperature</span>
                <span className="font-mono text-foreground">21.0 °C</span>
              </div>
              <div className="h-1.5 rounded bg-secondary">
                <div className="h-1.5 w-2/5 rounded bg-primary/70" />
              </div>
              <p className="font-mono text-[10px]">sensor get tmp112@48</p>
            </div>
          </div>
        </section>

        <section className="space-y-3" data-preview="identity-card">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Identity card
          </h2>
          <div className="rounded-lg border border-border bg-card p-1">
            <IdentityCard part={tmp112} />
          </div>
        </section>
      </main>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="h-[min(85vh,42rem)] max-w-xl" data-preview="catalog">
          <DialogHeader>
            <DialogTitle>Supported parts</DialogTitle>
            <DialogDescription>
              Simulated chips the browser can attach on virtio-i2c / virtio-spi —
              each with manufacturer, Zephyr compatible, and datasheet when one is
              linkable.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-2">
            {featured.map((part) => (
              <IdentityCard key={part.id} part={part} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
