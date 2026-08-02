import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DsGuess, DsKind } from '@/debug/ds'

export type ViewAsKind = 'hex' | DsKind

const OPTIONS: { kind: ViewAsKind; label: string; tag: string }[] = [
  { kind: 'hex', label: 'Hex dump', tag: 'default' },
  { kind: 'rbtree', label: 'rbtree', tag: 'sys/rb.h' },
  { kind: 'ring_buf', label: 'ring_buf', tag: 'sys/ring_buffer.h' },
  { kind: 'sys_slist', label: 'sys_slist', tag: 'sys/slist.h' },
  { kind: 'sys_dlist', label: 'sys_dlist', tag: 'sys/dlist.h' },
]

export function ViewAsMenu({
  value,
  onChange,
  guesses,
  disabled,
}: {
  value: ViewAsKind
  onChange: (v: ViewAsKind) => void
  guesses?: DsGuess[]
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const current = OPTIONS.find((o) => o.kind === value)
  const label =
    value === 'hex' ? 'View as ▾' : `${current?.label ?? value} ▾`

  const guessMap = new Map(guesses?.map((g) => [g.kind, g]))

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        variant="secondary"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 min-w-[12rem] rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {OPTIONS.map((opt, i) => {
            const g = opt.kind === 'hex' ? undefined : guessMap.get(opt.kind as DsKind)
            const maybe = g && g.score >= 0.5
            return (
              <div key={opt.kind}>
                {i === 1 ? <div className="my-1 border-t border-border" /> : null}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === opt.kind}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
                    value === opt.kind
                      ? 'bg-primary/15 text-primary'
                      : 'text-foreground hover:bg-muted',
                  )}
                  onClick={() => {
                    onChange(opt.kind)
                    setOpen(false)
                  }}
                >
                  <span>
                    {opt.label}
                    {maybe ? (
                      <span className="ml-1 text-[9px] text-muted-foreground">maybe</span>
                    ) : null}
                  </span>
                  <span className="font-mono text-[9px] text-muted-foreground">{opt.tag}</span>
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
