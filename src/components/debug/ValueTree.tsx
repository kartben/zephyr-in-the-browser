/**
 * Values as VS Code's Variables view lists them: `name: value`, the type on
 * hover, and a chevron on anything with members or elements. Children are
 * read when a row is opened, never before, since each read is a round trip
 * to the gdbstub.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ValueView } from '@/debug/dwarf/values'
import { cn } from '@/lib/utils'

export function ValueTree({ views, depth = 0 }: { views: ValueView[]; depth?: number }) {
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} className="font-mono text-[11px] leading-[1.35rem]">
      {views.map((view, i) => (
        <ValueRow key={`${view.name}:${i}`} view={view} depth={depth} />
      ))}
    </ul>
  )
}

function ValueRow({ view, depth }: { view: ValueView; depth: number }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<ValueView[] | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const toggle = () => {
    if (!view.expandable) return
    if (!open && children === null) {
      void view.children().then((kids) => {
        if (mounted.current) setChildren(kids)
      })
    }
    setOpen(!open)
  }

  return (
    <li role="treeitem" aria-expanded={view.expandable ? open : undefined}>
      <div
        className={cn(
          'flex min-w-0 items-baseline gap-1 whitespace-nowrap rounded-sm pr-1',
          view.expandable && 'cursor-pointer hover:bg-muted/60',
        )}
        style={{ paddingLeft: `${depth * 0.75}rem` }}
        onClick={toggle}
        title={view.typeName || undefined}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3 shrink-0 self-center text-muted-foreground/70 transition-transform',
            !view.expandable && 'invisible',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 text-primary-text/90">{view.name}</span>
        <span className="shrink-0 text-muted-foreground">:</span>
        <span
          className={cn(
            'min-w-0 truncate',
            view.unavailable ? 'italic text-muted-foreground' : 'text-foreground',
          )}
        >
          {view.text}
        </span>
      </div>
      {open &&
        (children ? (
          <ValueTree views={children} depth={depth + 1} />
        ) : (
          <p
            className="text-muted-foreground/70"
            style={{ paddingLeft: `${(depth + 1) * 0.75 + 1}rem` }}
          >
            …
          </p>
        ))}
    </li>
  )
}
