/**
 * Quiet debug surface attached to the Pause control.
 *
 * Invisible while the guest is running. While paused it shows a one-line PC
 * chip; opening it reveals Step + the raw register dump. No dock row, no stage
 * widget, no always-on TopBar chrome — the existing Pause button is the only
 * entry point.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Pause, Play, Redo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getSnapshot as getMonitor,
  step as stepGuest,
  subscribe as subscribeMonitor,
  toggle as togglePause,
} from '@/hostMonitor'

export function PauseDebugControl() {
  const monitor = useSyncExternalStore(subscribeMonitor, getMonitor, getMonitor)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  // Close the popover when the guest resumes (or the bridge goes away).
  useEffect(() => {
    if (!monitor.paused || !monitor.available) setOpen(false)
  }, [monitor.paused, monitor.available])

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

  if (!monitor.available) return null

  return (
    <span ref={rootRef} className="relative flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={monitor.paused ? 'Resume the machine' : 'Pause the machine'}
        title={monitor.paused ? 'Resume the machine' : 'Pause the machine'}
        aria-pressed={monitor.paused}
        onClick={togglePause}
      >
        {monitor.paused ? (
          <Play className="size-4 text-primary" />
        ) : (
          <Pause className="size-4" />
        )}
      </Button>

      {monitor.paused && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 max-w-[9.5rem] shrink gap-1 px-1.5 font-mono text-[11px] text-muted-foreground',
            open && 'bg-secondary text-foreground',
          )}
          aria-label="CPU registers"
          aria-expanded={open}
          title={monitor.summary ?? 'CPU registers'}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="truncate">
            {monitor.registersLoading && !monitor.summary
              ? '…'
              : (monitor.summary ?? 'regs')}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
        </Button>
      )}

      {open && monitor.paused && <DebugPopover />}
    </span>
  )
}

function DebugPopover() {
  const monitor = useSyncExternalStore(subscribeMonitor, getMonitor, getMonitor)
  const [stepping, setStepping] = useState(false)

  const onStep = async () => {
    if (stepping) return
    setStepping(true)
    try {
      await stepGuest()
    } finally {
      setStepping(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-label="CPU debug"
      className="absolute right-0 top-full z-50 mt-1 w-[22rem] max-w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card p-2 shadow-xl"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            CPU
          </div>
          <div className="truncate font-mono text-xs text-foreground">
            {monitor.summary ?? (monitor.registersLoading ? 'Reading…' : 'No registers')}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          disabled={stepping || monitor.registersLoading}
          onClick={() => void onStep()}
          title="Step one instruction"
        >
          <Redo2 className="size-3.5" aria-hidden />
          Step
        </Button>
      </div>

      <pre
        className="max-h-48 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
        tabIndex={0}
      >
        {monitor.registers?.trim() ||
          (monitor.registersLoading ? 'Reading registers…' : 'No register dump yet.')}
      </pre>
    </div>
  )
}
