import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { compactHex } from '@/debug/hexFormat'
import * as debug from '@/debug/control'
import { formatHexDump } from '@/components/debug/formatHexDump'

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
