import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HexView } from '@/components/HexView'
import { compactHex } from '@/debug/hexFormat'
import * as debug from '@/debug/control'
import {
  createDebugMemoryChip,
  type DebugMemoryChip,
} from '@/debug/debugMemoryChip'
import {
  BYTES_PER_ROW,
  VISIBLE_ROWS,
  WINDOW_BYTES,
  applyWindowSlide,
  pcWindowTop,
  planWindowSlide,
  scrollMemoryAddr,
  wheelRowDelta,
} from '@/components/debug/memoryView'
import {
  SEARCH_CHUNK_BYTES,
  parseSearchPattern,
  scanMemory,
  type SearchDirection,
} from '@/components/debug/memorySearch'
import { hexToBytes } from '@/debug/gdb/rspCodec'

function parseAddr(text: string): number | null {
  const raw = text.trim().replace(/^0x/i, '')
  if (!raw) return 0
  const addr = Number.parseInt(raw, 16)
  return Number.isFinite(addr) ? addr >>> 0 : null
}

function initialAddr(snap: debug.DebugSnapshot): { text: string; addr: number } {
  if (snap.memory) {
    return {
      text: compactHex(snap.memory.addr.toString(16)),
      addr: snap.memory.addr,
    }
  }
  if (snap.pc) {
    const addr = pcWindowTop(parseAddr(snap.pc) ?? 0, snap.regArch)
    return { text: compactHex(addr.toString(16)), addr }
  }
  return { text: '0', addr: 0 }
}

function windowTopForHit(hit: number): number {
  return Math.floor((hit >>> 0) / BYTES_PER_ROW) * BYTES_PER_ROW
}

export function MemoryPane({
  snap,
  seedAddr,
  onSeedConsumed,
}: {
  snap: debug.DebugSnapshot
  seedAddr: string | null
  onSeedConsumed: () => void
}) {
  const first = initialAddr(snap)
  const [addrText, setAddrText] = useState(first.text)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const queuedAddr = useRef<number | null>(null)
  const viewAddr = useRef(first.addr)
  // Only latch after a paused seed — Mem can mount while running (grayed).
  const booted = useRef(false)
  const chipRef = useRef<DebugMemoryChip | null>(null)

  const [patternText, setPatternText] = useState('')
  const [direction, setDirection] = useState<SearchDirection>('forward')
  const [searching, setSearching] = useState(false)
  const [searchStatus, setSearchStatus] = useState<string | null>(null)
  const searchAbort = useRef<AbortController | null>(null)
  const lastHit = useRef<number | null>(null)

  const loadAt = async (addr: number) => {
    const top = addr >>> 0
    viewAddr.current = top
    setAddrText(compactHex(top.toString(16)))
    if (busyRef.current) {
      queuedAddr.current = top
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      for (;;) {
        const target = queuedAddr.current ?? top
        queuedAddr.current = null
        viewAddr.current = target
        setAddrText(compactHex(target.toString(16)))

        const peek = debug.getSnapshot().memory
        const plan = peek
          ? planWindowSlide(peek.addr, peek.hex.length / 2, target, WINDOW_BYTES)
          : ({ kind: 'full', addr: target, length: WINDOW_BYTES } as const)

        if (plan.kind === 'noop') {
          if (queuedAddr.current === null) break
          continue
        }

        if (plan.kind === 'forward' || plan.kind === 'backward') {
          let edge: Uint8Array | null = null
          for (let attempt = 0; attempt < 8 && !edge; attempt++) {
            edge = await debug.readMemoryRaw(plan.fetchAddr, plan.fetchLen)
            if (!edge || edge.length < plan.fetchLen) {
              edge = null
              await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
            }
          }
          if (edge && peek) {
            const next = applyWindowSlide(hexToBytes(peek.hex), plan, edge)
            debug.setMemoryWindow(plan.addr, next)
            if (queuedAddr.current === null) break
            continue
          }
          // Fall through to a full window read if the edge peek failed.
        }

        let hex: string | null = null
        for (let attempt = 0; attempt < 8 && !hex; attempt++) {
          hex = await debug.readMemory(target, WINDOW_BYTES)
          if (!hex) await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
        }
        if (queuedAddr.current === null) break
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!seedAddr) return
    if (!snap.paused) return
    booted.current = true
    setAddrText(seedAddr)
    onSeedConsumed()
    const addr = parseAddr(seedAddr)
    if (addr !== null) void loadAt(addr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedAddr, snap.paused])

  // First pause: land on PC. Do not seed while the guest is still running.
  useEffect(() => {
    if (!snap.paused || booted.current || seedAddr) return
    if (snap.memory) {
      booted.current = true
      viewAddr.current = snap.memory.addr
      setAddrText(compactHex(snap.memory.addr.toString(16)))
      if (snap.memory.hex.length < WINDOW_BYTES * 2) void loadAt(snap.memory.addr)
      return
    }
    if (!snap.pc) return
    booted.current = true
    void loadAt(pcWindowTop(parseAddr(snap.pc) ?? 0, snap.regArch))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedAddr, snap.paused, snap.memory, snap.pc, snap.regArch])

  // Regs refreshed with no PC — fall back to 0 once, never before a refresh.
  useEffect(() => {
    if (!snap.paused || booted.current || seedAddr || snap.memory || snap.pc) return
    if (snap.registersLoading || snap.registers === null) return
    booted.current = true
    void loadAt(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedAddr, snap.paused, snap.memory, snap.pc, snap.registersLoading, snap.registers])

  useEffect(() => {
    return () => searchAbort.current?.abort()
  }, [])

  useEffect(() => {
    if (snap.paused) return
    if (!searching && !searchAbort.current) return
    searchAbort.current?.abort()
    searchAbort.current = null
    setSearching(false)
    setSearchStatus((s) => (s && s !== 'cancelled' ? 'cancelled' : s))
  }, [snap.paused, searching])

  const memory = snap.memory
  if (!memory) {
    chipRef.current = null
  } else {
    const len = memory.hex.length / 2
    const cur = chipRef.current
    if (!cur || cur.baseAddr !== memory.addr || cur.decl.size !== len) {
      chipRef.current = createDebugMemoryChip(memory.addr, memory.hex)
    } else {
      cur.apply(memory.hex)
    }
  }
  const chip = chipRef.current

  const shellRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(snap.paused)
  pausedRef.current = snap.paused

  const load = async () => {
    const addr = parseAddr(addrText)
    if (addr === null) return
    await loadAt(addr)
  }

  const moveByRows = (rowDelta: number) => {
    if (rowDelta === 0 || !pausedRef.current) return
    void loadAt(scrollMemoryAddr(viewAddr.current, rowDelta))
  }

  // React's onWheel is passive — preventDefault is ignored and the page scrolls.
  useEffect(() => {
    const el = shellRef.current
    if (!el) return
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      moveByRows(wheelRowDelta(e.deltaY, e.deltaMode))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // loadAt / viewAddr live in refs; only rebind when the shell mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chip])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveByRows(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveByRows(-1)
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      moveByRows(VISIBLE_ROWS)
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      moveByRows(-VISIBLE_ROWS)
    }
  }

  const cancelSearch = () => {
    searchAbort.current?.abort()
    searchAbort.current = null
    setSearching(false)
    setSearchStatus('cancelled')
  }

  const runSearch = async () => {
    if (!snap.paused || searching) return
    const pattern = parseSearchPattern(patternText)
    if (!pattern) {
      setSearchStatus('enter hex or "ascii"')
      return
    }
    const ac = new AbortController()
    searchAbort.current?.abort()
    searchAbort.current = ac
    setSearching(true)
    setSearchStatus('…')

    const viewLen = Math.max(1, (snap.memory?.hex.length ?? 2) / 2)
    const origin =
      lastHit.current !== null
        ? direction === 'forward'
          ? (lastHit.current + 1) >>> 0
          : (lastHit.current - 1) >>> 0
        : direction === 'forward'
          ? viewAddr.current >>> 0
          : ((viewAddr.current + viewLen - 1) >>> 0)

    try {
      const hit = await scanMemory({
        pattern,
        origin,
        direction,
        chunkSize: SEARCH_CHUNK_BYTES,
        signal: ac.signal,
        read: (addr, length) => debug.readMemoryRaw(addr, length),
        onProgress: ({ addr }) => {
          setSearchStatus(compactHex(addr.toString(16)))
        },
      })
      if (ac.signal.aborted) return
      if (hit === null) {
        lastHit.current = null
        setSearchStatus('not found')
        return
      }
      lastHit.current = hit
      setSearchStatus(`hit ${compactHex(hit.toString(16))}`)
      await loadAt(windowTopForHit(hit))
    } finally {
      if (searchAbort.current === ac) searchAbort.current = null
      setSearching(false)
    }
  }

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
          disabled={busy || searching || !snap.paused}
          onClick={() => void load()}
        >
          Read
        </Button>
      </div>
      <div className="flex gap-1">
        <input
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-2 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
          placeholder='Find · hex or "ascii"'
          value={patternText}
          disabled={!snap.paused}
          onChange={(e) => {
            setPatternText(e.target.value)
            lastHit.current = null
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (searching) cancelSearch()
              else void runSearch()
            }
            if (e.key === 'Escape' && searching) {
              e.preventDefault()
              cancelSearch()
            }
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-7 w-7 shrink-0 px-0"
          disabled={!snap.paused || searching}
          title={direction === 'forward' ? 'Search down' : 'Search up'}
          aria-label={direction === 'forward' ? 'Search down' : 'Search up'}
          onClick={() => {
            setDirection((d) => (d === 'forward' ? 'backward' : 'forward'))
            lastHit.current = null
          }}
        >
          {direction === 'forward' ? (
            <ArrowDown className="size-3.5" aria-hidden />
          ) : (
            <ArrowUp className="size-3.5" aria-hidden />
          )}
        </Button>
        {searching ? (
          <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={cancelSearch}>
            Cancel
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!snap.paused}
            onClick={() => void runSearch()}
          >
            Find
          </Button>
        )}
      </div>
      {searchStatus && (
        <p className="px-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
          {searching ? `scan ${searchStatus}` : searchStatus}
        </p>
      )}
      {chip ? (
        <div
          ref={shellRef}
          className="overscroll-contain outline-none focus:ring-1 focus:ring-ring"
          tabIndex={0}
          onKeyDown={onKeyDown}
          aria-label="Memory dump. Scroll or use arrow keys to move."
        >
          <HexView chip={chip} addressBase={chip.baseAddr} dimErased={false} />
        </div>
      ) : (
        <p className="rounded-md bg-muted/40 px-2 py-3 font-mono text-[10px] text-muted-foreground">
          Enter an address and Read — or click a register.
        </p>
      )}
    </div>
  )
}
