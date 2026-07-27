/**
 * Quiet debug surface attached to the Pause control.
 *
 * Invisible while the guest is running. While paused: PC chip + popover with
 * CPU regs, and (when gdbstub is attached) Step, breakpoints, memory, threads.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Pause, Play, Redo2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RegisterGrid } from '@/components/RegisterGrid'
import { compactHex } from '@/debug/hexFormat'
import { filterSymbols, type ElfSymbol } from '@/debug/elfSymbols'
import { formatStackSize, describeThreadStatus } from '@/debug/kernel/threads'
import { cn } from '@/lib/utils'
import * as debug from '@/debug/control'

type Tab = 'cpu' | 'breakpoints' | 'memory' | 'threads'

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

  const chipLabel = snap.registersLoading && !snap.summary
    ? '…'
    : snap.pcLabel
      ? snap.pcLabel
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

      {snap.paused && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 max-w-[11rem] shrink gap-1 px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground',
            open && 'bg-secondary text-foreground',
          )}
          aria-label="CPU debug"
          aria-expanded={open}
          title={
            snap.pcLabel && snap.pc
              ? `${snap.pcLabel} (0x${compactHex(snap.pc)})`
              : snap.pc
                ? `0x${snap.pc}`
                : 'CPU debug'
          }
          onClick={() => setOpen((value) => !value)}
        >
          <span className="truncate">{chipLabel}</span>
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
  const [peekAddr, setPeekAddr] = useState<string | null>(null)
  const [peekLen, setPeekLen] = useState(64)

  const onStep = async () => {
    if (stepping || !snap.canStep) return
    setStepping(true)
    try {
      await debug.step()
    } finally {
      setStepping(false)
    }
  }

  const onPeek = (addrHex: string, length = 64) => {
    setPeekAddr(compactHex(addrHex))
    setPeekLen(length)
    setTab('memory')
  }

  const tabs = (
    [
      ['cpu', 'CPU'],
      ['breakpoints', 'Break'],
      ['memory', 'Mem'],
      ['threads', 'Threads'],
    ] as const
  ).filter(([id]) => id !== 'threads' || snap.gdb)

  return (
    <div
      role="dialog"
      aria-label="CPU debug"
      className="absolute right-0 top-full z-50 mt-1 w-[30rem] max-w-[min(30rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card p-2.5 shadow-xl"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-foreground/55">
            {snap.gdb ? 'gdb' : 'CPU · QMP'}
          </div>
          <div className="truncate font-mono text-xs tabular-nums text-foreground">
            {snap.pcLabel ? (
              <>
                <span className="text-foreground">{snap.pcLabel}</span>
                {snap.pc && (
                  <span className="ml-1.5 text-foreground/55">
                    {compactHex(snap.pc)}
                  </span>
                )}
              </>
            ) : snap.pc ? (
              `PC ${compactHex(snap.pc)}`
            ) : (
              (snap.summary ?? (snap.registersLoading ? 'Reading…' : 'No registers'))
            )}
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
        <div className="mb-2 flex gap-0.5 px-1">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                'rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide',
                tab === id
                  ? 'bg-secondary text-foreground'
                  : 'text-foreground/55 hover:bg-muted/60 hover:text-foreground',
              )}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {(!snap.gdb || tab === 'cpu') && (
        <RegisterGrid
          dump={snap.registers}
          loading={snap.registersLoading}
          onPeek={snap.gdb ? onPeek : undefined}
          pcLabel={snap.pcLabel}
          formals={snap.regFormals}
          arch={snap.regArch}
        />
      )}

      {snap.gdb && tab === 'breakpoints' && <BreakpointsPane snap={snap} />}
      {snap.gdb && tab === 'memory' && (
        <MemoryPane
          snap={snap}
          seedAddr={peekAddr}
          seedLen={peekLen}
          onSeedConsumed={() => setPeekAddr(null)}
        />
      )}
      {snap.gdb && tab === 'threads' && <ThreadsPane snap={snap} onPeek={onPeek} />}
    </div>
  )
}

function BreakpointsPane({ snap }: { snap: debug.DebugSnapshot }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const suggestions = useMemo(() => {
    if (!snap.hasSymbols) return [] as ElfSymbol[]
    // Build a tiny index-shaped object for filterSymbols.
    return filterSymbols(
      { byAddr: snap.symbols, byName: snap.symbols },
      text.startsWith('0x') || /^[0-9a-f]+$/i.test(text.trim()) ? '' : text,
      36,
    )
  }, [snap.hasSymbols, snap.symbols, text])

  useEffect(() => {
    if (!pickerOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [pickerOpen])

  const addAt = async (addr: number) => {
    setBusy(true)
    setError(null)
    try {
      const ok = await debug.addBreakpoint(addr)
      if (!ok) setError('Breakpoint rejected')
      else {
        setText('')
        setPickerOpen(false)
      }
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const raw = text.trim().replace(/^0x/i, '')
    // Name match first when symbols exist.
    if (snap.hasSymbols && /[a-z_]/i.test(raw)) {
      const hit = snap.symbols.find((s) => s.name === text.trim())
        ?? snap.symbols.find((s) => s.name.toLowerCase() === text.trim().toLowerCase())
      if (hit) {
        await addAt(hit.addr)
        return
      }
    }
    const addr = Number.parseInt(raw, 16)
    if (!Number.isFinite(addr)) {
      setError(snap.hasSymbols ? 'Pick a symbol or enter a hex address' : 'Enter a hex address')
      return
    }
    await addAt(addr)
  }

  return (
    <div className="space-y-2 px-1">
      <ul className="max-h-36 space-y-1 overflow-auto text-[11px]">
        {snap.breakpoints.length === 0 && (
          <li className="text-foreground/55">No breakpoints</li>
        )}
        {snap.breakpoints.map((bp) => (
          <li key={bp.addr} className="flex items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {bp.label ?? (
                <span className="font-mono tabular-nums">{compactHex(bp.addrHex)}</span>
              )}
            </span>
            {bp.label && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/60">
                {compactHex(bp.addrHex)}
              </span>
            )}
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

      <div ref={boxRef} className="relative space-y-1">
        <div className="flex gap-1">
          <input
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
            placeholder={snap.hasSymbols ? 'Symbol or hex…' : 'Break at… (hex)'}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setPickerOpen(true)
            }}
            onFocus={() => setPickerOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
              if (e.key === 'Escape') setPickerOpen(false)
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

        {pickerOpen && snap.hasSymbols && suggestions.length > 0 && (
          <ul
            className="absolute left-0 right-0 z-10 max-h-44 overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
            role="listbox"
          >
            {suggestions.map((s) => (
              <li key={`${s.name}@${s.addr}`}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-secondary"
                  onClick={() => void addAt(s.addr)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                    {s.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/60">
                    {compactHex(s.addr.toString(16))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  )
}

function MemoryPane({
  snap,
  seedAddr,
  seedLen,
  onSeedConsumed,
}: {
  snap: debug.DebugSnapshot
  seedAddr: string | null
  seedLen: number
  onSeedConsumed: () => void
}) {
  const defaultAddr = snap.pc ? compactHex(snap.pc) : ''
  const [addrText, setAddrText] = useState(
    snap.memory ? compactHex(snap.memory.addr.toString(16)) : defaultAddr,
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!seedAddr) return
    setAddrText(seedAddr)
    onSeedConsumed()
    const addr = Number.parseInt(seedAddr, 16)
    if (Number.isFinite(addr)) void debug.readMemory(addr, seedLen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedAddr])

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
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2 font-mono text-[11px] tabular-nums text-foreground outline-none focus:ring-1 focus:ring-ring"
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
        className="max-h-48 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-relaxed tabular-nums text-foreground/75"
        tabIndex={0}
      >
        {formatted || 'Enter an address and Read — or click a register.'}
      </pre>
    </div>
  )
}

function ThreadsPane({
  snap,
  onPeek,
}: {
  snap: debug.DebugSnapshot
  onPeek: (addrHex: string, length?: number) => void
}) {
  if (!snap.threadInfo) {
    return (
      <p className="px-1 py-3 text-[11px] leading-relaxed text-foreground/60">
        Needs an unstripped ELF built with{' '}
        <code className="text-foreground/80">CONFIG_DEBUG_THREAD_INFO</code> (same
        symbols OpenOCD uses). Packaged images ship that way; a stripped drop-in
        will not.
      </p>
    )
  }
  if (snap.threadsLoading && snap.threads.length === 0) {
    return (
      <p className="px-1 py-3 text-center text-[11px] text-foreground/60">Reading threads…</p>
    )
  }
  if (snap.threadsError) {
    return <p className="px-1 py-3 text-[11px] text-destructive">{snap.threadsError}</p>
  }
  if (snap.threads.length === 0) {
    return <p className="px-1 py-3 text-[11px] text-foreground/60">No threads found.</p>
  }

  return (
    <ul className="max-h-[min(24rem,55vh)] space-y-1 overflow-auto px-0.5">
      {snap.threads.map((t) => {
        const status = describeThreadStatus(t)
        const stackAddr = t.stackStart ?? t.sp
        return (
          <li
            key={t.addr}
            className={cn(
              'rounded-md px-2 py-1.5',
              t.current ? 'bg-primary/10 ring-1 ring-primary/25' : 'hover:bg-muted/50',
            )}
          >
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  'mt-1.5 size-1.5 shrink-0 rounded-full',
                  t.current ? 'bg-primary' : 'bg-foreground/35',
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <button
                    type="button"
                    className="min-w-0 truncate text-left text-[12px] font-medium text-foreground"
                    title={`Peek TCB at 0x${t.addr.toString(16)}`}
                    onClick={() => onPeek(t.addr.toString(16))}
                  >
                    {t.name}
                  </button>
                  {t.prio != null && (
                    <span
                      className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/70"
                      title="Scheduler priority (negative = cooperative)"
                    >
                      <span className="text-foreground/40">prio </span>
                      {t.prio}
                    </span>
                  )}
                </div>

                {status.label && (
                  <div className="mt-0.5 text-[11px] leading-snug text-foreground/70">
                    <span className="text-foreground/90">{status.label}</span>
                    {status.detail && (
                      <>
                        <span className="text-foreground/40"> on </span>
                        {status.detailAddr != null ? (
                          <button
                            type="button"
                            className="font-mono text-primary underline-offset-2 hover:underline"
                            title={`Peek wait object at 0x${status.detailAddr.toString(16)}`}
                            onClick={() => onPeek(status.detailAddr!.toString(16))}
                          >
                            {status.detail}
                          </button>
                        ) : (
                          <span className="font-mono text-foreground/80">{status.detail}</span>
                        )}
                      </>
                    )}
                  </div>
                )}

                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums text-foreground/50">
                  {t.stackSize != null && (
                    <span title="Stack buffer size">
                      stack {formatStackSize(t.stackSize)}
                    </span>
                  )}
                  {stackAddr != null && (
                    <button
                      type="button"
                      className="text-primary/90 underline-offset-2 hover:underline"
                      title={
                        t.stackStart != null
                          ? `Peek stack at 0x${t.stackStart.toString(16)}`
                          : `Peek SP 0x${stackAddr.toString(16)}`
                      }
                      onClick={() => onPeek(stackAddr.toString(16), 128)}
                    >
                      Mem {compactHex(stackAddr.toString(16))}
                    </button>
                  )}
                  <button
                    type="button"
                    className="hover:text-foreground/70"
                    title="Peek thread control block"
                    onClick={() => onPeek(t.addr.toString(16))}
                  >
                    tcb {compactHex(t.addr.toString(16))}
                  </button>
                </div>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function formatHexDump(addr: number, hex: string): string {
  if (!hex) return ''
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  const addrDigits = Math.max(8, compactHex(addr.toString(16)).length)
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.slice(i, i + 16)
    const hexPart = slice.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
    lines.push(
      `${(addr + i).toString(16).padStart(addrDigits, '0')}  ${hexPart.padEnd(47)}  ${ascii}`,
    )
  }
  return lines.join('\n')
}
