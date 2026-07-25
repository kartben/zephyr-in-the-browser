/**
 * A body-internal fold: chevron, title, an optional right-aligned meta value
 * that keeps reading while closed (an IP, a frame count). Open state belongs
 * to the caller — Network persists its set in dockStore, so the sections a
 * user keeps open survive reloads and pop-outs alike.
 */

import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Disclosure({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string
  meta?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1 rounded py-0.5 text-left hover:bg-secondary/50"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-muted-foreground/70 transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="text-xs font-medium">{title}</span>
        {meta !== undefined && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2 font-mono text-[10px] tabular-nums text-muted-foreground">
            {meta}
          </span>
        )}
      </button>
      {open && <div className="pb-1 pl-4 pt-0.5">{children}</div>}
    </div>
  )
}
