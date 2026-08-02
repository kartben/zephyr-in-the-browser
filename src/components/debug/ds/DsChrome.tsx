import type { ReactNode } from 'react'
import { compactHex } from '@/debug/hexFormat'
import { cn } from '@/lib/utils'

export function PtrChip({
  addr,
  onPeek,
  className,
}: {
  addr: number
  onPeek?: (addrHex: string) => void
  className?: string
}) {
  const hex = compactHex(addr.toString(16))
  if (!addr) {
    return <span className={cn('font-mono text-[10px] text-muted-foreground', className)}>NULL</span>
  }
  if (!onPeek) {
    return <span className={cn('font-mono text-[10px] tabular-nums text-sky-300/90', className)}>{hex}</span>
  }
  return (
    <button
      type="button"
      className={cn(
        'font-mono text-[10px] tabular-nums text-sky-300/90 underline decoration-sky-300/30 underline-offset-2 hover:text-sky-200',
        className,
      )}
      title={`Peek ${hex}`}
      onClick={() => onPeek(hex)}
    >
      {hex}
    </button>
  )
}

export function FieldRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] items-baseline gap-x-2 font-mono text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{children}</span>
    </div>
  )
}

export function StructCard({
  typeName,
  children,
  meta,
}: {
  typeName: string
  children: ReactNode
  meta?: string | null
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-amber-200/80">
        {typeName}
      </div>
      <div className="space-y-0.5">{children}</div>
      {meta ? <p className="mt-1.5 font-mono text-[9px] text-muted-foreground">{meta}</p> : null}
    </div>
  )
}
