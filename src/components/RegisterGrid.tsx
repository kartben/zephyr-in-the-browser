/**
 * Structured register grid for the pause debug popover.
 *
 * Featured row (PC / SP / LR) on top, then a compact two-column general grid,
 * then status/PSR. Falls back to a monospace pre when the dump cannot be parsed.
 */

import { organizeRegisters, type RegEntry } from '@/debug/registerModel'
import { cn } from '@/lib/utils'

export function RegisterGrid({
  dump,
  loading,
}: {
  dump: string | null
  loading?: boolean
}) {
  if (loading && !dump) {
    return (
      <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">Reading registers…</p>
    )
  }
  if (!dump?.trim()) {
    return (
      <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">No register dump yet.</p>
    )
  }

  const layout = organizeRegisters(dump)
  const hasStructure =
    layout.featured.length > 0 || layout.general.length > 0 || layout.status.length > 0

  if (!hasStructure) {
    return (
      <pre
        className="max-h-52 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
        tabIndex={0}
      >
        {dump.trim()}
      </pre>
    )
  }

  return (
    <div className="max-h-56 space-y-2.5 overflow-auto px-0.5" tabIndex={0}>
      {layout.featured.length > 0 && (
        <div
          className={cn(
            'grid gap-1.5',
            layout.featured.length >= 3 ? 'grid-cols-3' : 'grid-cols-2',
          )}
        >
          {layout.featured.map((reg) => (
            <FeaturedReg key={reg.name} reg={reg} />
          ))}
        </div>
      )}

      {layout.general.length > 0 && (
        <section>
          <SectionLabel>General</SectionLabel>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {layout.general.map((reg) => (
              <RegRow key={reg.name} reg={reg} />
            ))}
          </div>
        </section>
      )}

      {layout.status.length > 0 && (
        <section>
          <SectionLabel>Status</SectionLabel>
          <div className="grid grid-cols-1 gap-y-0.5">
            {layout.status.map((reg) => (
              <RegRow key={reg.name} reg={reg} wide />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80">
      {children}
    </div>
  )
}

function FeaturedReg({ reg }: { reg: RegEntry }) {
  const isPc = reg.name === 'PC'
  return (
    <div
      className={cn(
        'rounded-md px-2 py-1.5',
        isPc ? 'bg-primary/10 ring-1 ring-primary/25' : 'bg-muted/50',
      )}
    >
      <div
        className={cn(
          'text-[9px] font-medium uppercase tracking-wider',
          isPc ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        {reg.name}
      </div>
      <div
        className={cn(
          'truncate font-mono text-[11px] leading-tight',
          isPc ? 'text-foreground' : 'text-foreground/90',
        )}
        title={`0x${reg.value}`}
      >
        {reg.value}
      </div>
    </div>
  )
}

function RegRow({ reg, wide }: { reg: RegEntry; wide?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 py-px font-mono text-[10px] leading-snug">
      <span className="w-9 shrink-0 text-muted-foreground">{reg.name}</span>
      <span
        className={cn('min-w-0 text-foreground/90', wide ? 'truncate' : 'truncate')}
        title={`0x${reg.value}`}
      >
        {reg.value}
      </span>
    </div>
  )
}
