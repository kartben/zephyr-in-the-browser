/**
 * TopBar run-control for pause / step. Deep inspection lives in DebugPanel.
 *
 * gdb: Pause + Step + PC chip (or bps badge while running) → focuses Debug panel.
 * QMP-only: Pause + PC chip opens a small register popover (no Debug panel).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pause, Play, Redo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RegisterGrid } from '@/components/RegisterGrid'
import { compactHex } from '@/debug/hexFormat'
import { cn } from '@/lib/utils'
import * as debug from '@/debug/control'
import { focusDebug } from '@/lib/debugUi'

export function PauseDebugControl() {
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const [qmpOpen, setQmpOpen] = useState(false)
  const [stepping, setStepping] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!snap.paused || !snap.available || snap.gdb) setQmpOpen(false)
  }, [snap.paused, snap.available, snap.gdb])

  useEffect(() => {
    if (!qmpOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setQmpOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQmpOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [qmpOpen])

  if (!snap.available) return null

  const chipLabel =
    snap.registersLoading && !snap.summary
      ? '…'
      : snap.pcLabel
        ? snap.pcLabel
        : snap.pc
          ? `PC ${compactHex(snap.pc)}`
          : (snap.summary ?? 'regs')

  const onStep = async () => {
    if (stepping || !snap.canStep) return
    setStepping(true)
    try {
      await debug.step()
    } finally {
      setStepping(false)
    }
  }

  const openDebugCpu = () => focusDebug('cpu')
  const openDebugBreak = () => focusDebug('breakpoints')

  return (
    <span ref={rootRef} className="relative flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={snap.paused ? 'Resume the machine' : 'Pause the machine'}
        title={snap.paused ? 'Resume the machine' : 'Pause the machine'}
        aria-pressed={snap.paused}
        onClick={debug.toggle}
      >
        {snap.paused ? (
          <Play className="size-4 text-primary" />
        ) : (
          <Pause className="size-4" />
        )}
      </Button>

      {snap.paused && snap.canStep && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1 px-1.5 text-xs"
          disabled={stepping || snap.registersLoading}
          onClick={() => void onStep()}
          title="Step one instruction"
          aria-label="Step one instruction"
        >
          <Redo2 className="size-3.5" aria-hidden />
          Step
        </Button>
      )}

      {snap.gdb && !snap.paused && snap.breakpoints.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 max-w-[8rem] shrink gap-1 px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground"
          aria-label="Open Debug breakpoints"
          title="Open Debug panel"
          onClick={openDebugBreak}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          {snap.breakpoints.length} bp{snap.breakpoints.length === 1 ? '' : 's'}
        </Button>
      )}

      {snap.paused && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 max-w-[11rem] shrink gap-1 px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground',
            qmpOpen && 'bg-secondary text-foreground',
          )}
          aria-label={snap.gdb ? 'Open Debug CPU' : 'CPU registers'}
          aria-expanded={snap.gdb ? undefined : qmpOpen}
          title={
            snap.pcLabel && snap.pc
              ? `${snap.pcLabel} (0x${compactHex(snap.pc)})`
              : snap.pc
                ? `0x${snap.pc}`
                : 'CPU debug'
          }
          onClick={() => {
            if (snap.gdb) openDebugCpu()
            else setQmpOpen((value) => !value)
          }}
        >
          <span className="truncate">{chipLabel}</span>
        </Button>
      )}

      {qmpOpen && snap.paused && !snap.gdb && (
        <div
          role="dialog"
          aria-label="CPU registers"
          className="absolute right-0 top-full z-50 mt-1 w-[22rem] max-w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card p-2.5 shadow-xl"
        >
          <div className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wide text-foreground/55">
            CPU · QMP
          </div>
          <RegisterGrid
            dump={snap.registers}
            loading={snap.registersLoading}
            pcLabel={snap.pcLabel}
            formals={snap.regFormals}
            arch={snap.regArch}
          />
        </div>
      )}
    </span>
  )
}
