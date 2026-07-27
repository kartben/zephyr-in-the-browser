/**
 * Quiet debug surface attached to the Pause control.
 *
 * Invisible while the guest is running. While paused: PC chip + popover with
 * CPU regs, and (when gdbstub is attached) Step, breakpoints, and memory.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Pause, Play, Redo2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RegisterGrid } from '@/components/RegisterGrid'
import { cn } from '@/lib/utils'
import * as debug from '@/debug/control'

type Tab = 'cpu' | 'breakpoints' | 'memory'

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

      {snap.paused && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 max-w-[9.5rem] shrink gap-1 px-1.5 font-mono text-[11px] text-muted-foreground',
            open && 'bg-secondary text-foreground',
          )}
          aria-label="CPU debug"
          aria-expanded={open}
          title={snap.summary ?? 'CPU debug'}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="truncate">
            {snap.registersLoading && !snap.summary ? '…' : (snap.summary ?? 'regs')}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
        </Button>
      )}

      {open && snap.paused && <DebugPopover snap={snap} />}
    </span>
  )
}

function DebugPopover({ snap }: { snap: debug.DebugSnapshot }) {
  const [tab, setTab] = useState<Tab>('cpu')
  const [stepping, setStepping] = useState(false)

  const onStep = async () => {
    if (stepping || !snap.canStep) return
    setStepping(true)
    try {
      await debug.step()
    } finally {
      setStepping(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-label="CPU debug"
      className="absolute right-0 top-full z-50 mt-1 w-[26rem] max-w-[min(26rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card p-2.5 shadow-xl"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {snap.gdb ? 'gdb' : 'CPU'}
          </div>
          <div className="truncate font-mono text-xs text-foreground">
            {snap.summary ?? (snap.registersLoading ? 'Reading…' : 'No registers')}
          </div>
        </div>
        {snap.canStep && (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={stepping || snap.registersLoading}
            onClick={() => void onStep()}
            title="Step one instruction"
          >
            <Redo2 className="size-3.5" aria-hidden />
            Step
          </Button>
        )}
      </div>

      {snap.gdb && (
        <div className="mb-2 flex gap-1 px-1">
          {([
            ['cpu', 'CPU'],
            ['breakpoints', 'Breakpoints'],
            ['memory', 'Memory'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                'rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                tab === id
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {(!snap.gdb || tab === 'cpu') && (
        <RegisterGrid dump={snap.registers} loading={snap.registersLoading} />
      )}

      {snap.gdb && tab === 'breakpoints' && <BreakpointsPane snap={snap} />}
      {snap.gdb && tab === 'memory' && <MemoryPane snap={snap} />}
    </div>
  )
}

function BreakpointsPane({ snap }: { snap: debug.DebugSnapshot }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    const raw = text.trim().replace(/^0x/i, '')
    const addr = Number.parseInt(raw, 16)
    if (!Number.isFinite(addr)) {
      setError('Enter a hex address')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ok = await debug.addBreakpoint(addr)
      if (!ok) setError('Breakpoint rejected')
      else setText('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 px-1">
      <ul className="max-h-32 space-y-1 overflow-auto font-mono text-[11px]">
        {snap.breakpoints.length === 0 && (
          <li className="text-muted-foreground">No breakpoints</li>
        )}
        {snap.breakpoints.map((bp) => (
          <li key={bp.addr} className="flex items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-foreground">0x{bp.addrHex}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              title="Remove breakpoint"
              onClick={() => void debug.removeBreakpoint(bp.addr)}
            >
              <Trash2 className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex gap-1">
        <input
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-2 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
          placeholder="Break at… (hex)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  )
}

function MemoryPane({ snap }: { snap: debug.DebugSnapshot }) {
  const [addrText, setAddrText] = useState(snap.memory ? snap.memory.addr.toString(16) : '')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const raw = addrText.trim().replace(/^0x/i, '')
    const addr = Number.parseInt(raw, 16)
    if (!Number.isFinite(addr)) return
    setBusy(true)
    try {
      await debug.readMemory(addr, 64)
    } finally {
      setBusy(false)
    }
  }

  const formatted = formatHexDump(snap.memory?.addr ?? 0, snap.memory?.hex ?? '')

  return (
    <div className="space-y-2 px-1">
      <div className="flex gap-1">
        <input
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-2 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
          placeholder="Address (hex)"
          value={addrText}
          onChange={(e) => setAddrText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load()
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={() => void load()}
        >
          Read
        </Button>
      </div>
      <pre
        className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground"
        tabIndex={0}
      >
        {formatted || 'Enter an address and Read.'}
      </pre>
    </div>
  )
}

function formatHexDump(addr: number, hex: string): string {
  if (!hex) return ''
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.slice(i, i + 16)
    const hexPart = slice.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${(addr + i).toString(16).padStart(8, '0')}  ${hexPart.padEnd(47)}  ${ascii}`)
  }
  return lines.join('\n')
}
