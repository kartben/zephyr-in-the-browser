import { useEffect, useMemo, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { compactHex } from '@/debug/hexFormat'
import { filterSymbols, type ElfSymbol } from '@/debug/elfSymbols'
import * as debug from '@/debug/control'

export function BreakpointsPane({ snap }: { snap: debug.DebugSnapshot }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const suggestions = useMemo(() => {
    if (!snap.hasSymbols) return [] as ElfSymbol[]
    return filterSymbols(
      { byAddr: snap.symbols, byName: snap.symbols, objects: new Map() },
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
    if (snap.hasSymbols && /[a-z_]/i.test(raw)) {
      const hit =
        snap.symbols.find((s) => s.name === text.trim()) ??
        snap.symbols.find((s) => s.name.toLowerCase() === text.trim().toLowerCase())
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
