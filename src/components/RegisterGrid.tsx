/**
 * Structured register grid for the pause debug popover.
 *
 * Featured row (PC / SP / LR) on top, then a compact multi-column general grid,
 * then status/PSR. Falls back to a monospace pre when the dump cannot be parsed.
 */

import { compactHex, isInactiveRegValue } from '@/debug/hexFormat'
import { organizeRegisters, type RegEntry } from '@/debug/registerModel'
import { cn } from '@/lib/utils'

export function RegisterGrid({
  dump,
  loading,
  onPeek,
}: {
  dump: string | null
  loading?: boolean
  /** Click a value to peek that address in the Memory tab. */
  onPeek?: (addrHex: string) => void
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
        className="max-h-56 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
        tabIndex={0}
      >
        {dump.trim()}
      </pre>
    )
  }

  const generalCols = layout.general.length > 16 ? 3 : 2

  return (
    <div className="max-h-[min(22rem,50vh)] space-y-2.5 overflow-auto px-0.5" tabIndex={0}>
      {layout.featured.length > 0 && (
        <div
          className={cn(
            'grid gap-1.5',
            layout.featured.length >= 3 ? 'grid-cols-3' : 'grid-cols-2',
          )}
        >
          {layout.featured.map((reg) => (
            <FeaturedReg key={reg.name} reg={reg} onPeek={onPeek} />
          ))}
        </div>
      )}

      {layout.general.length > 0 && (
        <section>
          <SectionLabel>General</SectionLabel>
          <div
            className={cn(
              'grid gap-x-2 gap-y-0.5',
              generalCols === 3 ? 'grid-cols-3' : 'grid-cols-2',
            )}
          >
            {layout.general.map((reg) => (
              <RegRow key={reg.name} reg={reg} onPeek={onPeek} />
            ))}
          </div>
        </section>
      )}

      {layout.status.length > 0 && (
        <section>
          <SectionLabel>Status</SectionLabel>
          <div
            className={cn(
              'grid gap-1.5',
              layout.status.length === 1 ? 'grid-cols-1' : 'grid-cols-2',
            )}
          >
            {layout.status.map((reg) => (
              <FeaturedReg key={reg.name} reg={reg} onPeek={onPeek} />
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

function FeaturedReg({
  reg,
  onPeek,
}: {
  reg: RegEntry
  onPeek?: (addrHex: string) => void
}) {
  const isPc = reg.name === 'PC'
  const display = compactHex(reg.value)
  return (
    <button
      type="button"
      className={cn(
        'rounded-md px-2 py-1.5 text-left transition-colors',
        isPc ? 'bg-primary/10 ring-1 ring-primary/25' : 'bg-muted/45 hover:bg-muted/70',
        onPeek && 'cursor-pointer',
      )}
      title={`0x${reg.value}${onPeek ? ' — click to peek memory' : ''}`}
      onClick={() => onPeek?.(reg.value)}
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
          'truncate font-mono text-[11px] leading-tight tabular-nums',
          isPc ? 'text-foreground' : 'text-foreground/90',
        )}
      >
        {display}
      </div>
    </button>
  )
}

function RegRow({
  reg,
  wide,
  onPeek,
}: {
  reg: RegEntry
  wide?: boolean
  onPeek?: (addrHex: string) => void
}) {
  const display = compactHex(reg.value)
  const dim = isInactiveRegValue(reg.value)
  return (
    <button
      type="button"
      className={cn(
        'flex min-w-0 items-baseline rounded px-0.5 py-px text-left font-mono text-[10px] leading-snug',
        wide ? 'gap-2' : 'gap-1',
        onPeek && 'hover:bg-muted/50',
        dim && 'opacity-40',
      )}
      title={`0x${reg.value}${onPeek ? ' — click to peek memory' : ''}`}
      onClick={() => onPeek?.(reg.value)}
    >
      <span
        className={cn(
          'shrink-0 overflow-hidden text-ellipsis text-muted-foreground',
          // Status names (PSTATE, XPSR, …) need more than the GPR column.
          wide ? 'w-[4.5rem]' : 'w-7',
        )}
      >
        {reg.name}
      </span>
      <span className="min-w-0 truncate tabular-nums text-foreground/90">{display}</span>
    </button>
  )
}
