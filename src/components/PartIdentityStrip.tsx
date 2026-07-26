/**
 * Compact identity strip for a simulated part: manufacturer · part · compatible,
 * plus datasheet / binding links when we have URLs.
 *
 * Used on live chip bodies and inside the parts catalog. Keeps the same facts
 * as {@link PartIdentity} — no panel invents its own datasheet link.
 */

import type { ReactNode } from 'react'
import { BookOpen, ExternalLink, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { partById, type PartIdentity } from '@/virtio/devices/parts'

export function PartIdentityStrip({
  partId,
  part,
  className,
  compact = false,
  links = true,
}: {
  partId?: string
  part?: PartIdentity
  className?: string
  /** One-line dock form: hide the summary sentence. */
  compact?: boolean
  /** Show datasheet / binding affordances (default true). */
  links?: boolean
}) {
  const identity = part ?? (partId ? partById(partId) : undefined)
  if (!identity) return null

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-snug text-muted-foreground">
        <span className="font-medium text-foreground/80">{identity.manufacturer}</span>
        <span aria-hidden>·</span>
        <span className="font-mono text-foreground/90">{identity.part}</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{identity.compatible}</span>
        {links && (
          <span className="ml-auto flex items-center gap-0.5">
            {identity.datasheetUrl && (
              <PartLink href={identity.datasheetUrl} title={`${identity.part} datasheet`}>
                <FileText className="size-3" aria-hidden />
                {!compact && <span>Datasheet</span>}
              </PartLink>
            )}
            {identity.bindingUrl && (
              <PartLink href={identity.bindingUrl} title="Zephyr DT binding">
                <BookOpen className="size-3" aria-hidden />
                {!compact && <span>Binding</span>}
              </PartLink>
            )}
          </span>
        )}
      </div>
      {!compact && (
        <p className="text-[11px] leading-snug text-muted-foreground">{identity.summary}</p>
      )}
    </div>
  )
}

function PartLink({
  href,
  title,
  children,
}: {
  href: string
  title: string
  children: ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={title}
      className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
      <ExternalLink className="size-2.5 opacity-60" aria-hidden />
    </a>
  )
}
