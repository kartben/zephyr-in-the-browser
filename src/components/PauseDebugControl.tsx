/**
 * TopBar run control: stop and start the machine, whatever is driving it.
 *
 * This used to stand down whenever gdb was attached, because the Debug panel
 * floated over the terminal and always had its own Pause. Debug is a dock row
 * now and the dock can be closed, so global run control has to live somewhere
 * that is always on screen. The Debug body keeps its own Pause/Continue beside
 * the step buttons — that pair belongs together while you are stepping.
 *
 * The register popover stays QMP-only: a gdb session has the whole Debug row.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RegisterGrid } from '@/components/RegisterGrid'
import { compactHex } from '@/debug/hexFormat'
import { cn } from '@/lib/utils'
import * as debug from '@/debug/control'

export function PauseDebugControl() {
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!snap.paused || !snap.available) setOpen(false)
  }, [snap.paused, snap.available])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!snap.available) return null

  const chipLabel =
    snap.registersLoading && !snap.summary
      ? '…'
      : snap.pc
        ? `PC ${compactHex(snap.pc)}`
        : (snap.summary ?? 'regs')

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

      {snap.paused && !snap.gdb && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 max-w-[11rem] shrink gap-1 px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground',
            open && 'bg-secondary text-foreground',
          )}
          aria-label="CPU registers"
          aria-expanded={open}
          title={snap.pc ? `0x${snap.pc}` : 'CPU registers'}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="truncate">{chipLabel}</span>
        </Button>
      )}

      {open && snap.paused && (
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
