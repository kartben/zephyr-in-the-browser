import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { HexView } from '@/components/HexView'
import { compactHex } from '@/debug/hexFormat'
import * as debug from '@/debug/control'
import {
  createDebugMemoryChip,
  type DebugMemoryChip,
} from '@/debug/debugMemoryChip'

export function MemoryPane({
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
  const chipRef = useRef<DebugMemoryChip | null>(null)

  useEffect(() => {
    if (!seedAddr) return
    setAddrText(seedAddr)
    onSeedConsumed()
    const addr = Number.parseInt(seedAddr, 16)
    if (Number.isFinite(addr)) void debug.readMemory(addr, seedLen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedAddr])

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
          disabled={busy || !snap.paused}
          onClick={() => void load()}
        >
          Read
        </Button>
      </div>
      {chip ? (
        <HexView chip={chip} addressBase={chip.baseAddr} dimErased={false} />
      ) : (
        <p className="rounded-md bg-muted/40 px-2 py-3 font-mono text-[10px] text-muted-foreground">
          Enter an address and Read — or click a register.
        </p>
      )}
    </div>
  )
}
