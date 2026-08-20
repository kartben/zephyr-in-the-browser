import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { RbTreeView } from '@/components/debug/ds/RbTreeView'
import { RingBufView } from '@/components/debug/ds/RingBufView'
import { SListView } from '@/components/debug/ds/SListView'
import { DListView } from '@/components/debug/ds/DListView'
import type { ViewAsKind } from '@/components/debug/ds/ViewAsMenu'
import {
  loadDList,
  loadRbTree,
  loadRingBuf,
  loadSList,
  ptrWidthForArch,
  type DListWalk,
  type RbTreeWalk,
  type RingBuf,
  type SListWalk,
} from '@/debug/ds'
import * as debug from '@/debug/control'

export function DsPane({
  kind,
  addr,
  arch,
  paused,
  onPeek,
  onBackHex,
}: {
  kind: Exclude<ViewAsKind, 'hex'>
  addr: number
  arch: 'arm' | 'aarch64' | 'riscv32' | null
  paused: boolean
  onPeek?: (addrHex: string) => void
  onBackHex: () => void
}) {
  const width = ptrWidthForArch(arch)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rb, setRb] = useState<RbTreeWalk | null>(null)
  const [ring, setRing] = useState<RingBuf | null>(null)
  const [slist, setSlist] = useState<SListWalk | null>(null)
  const [dlist, setDlist] = useState<DListWalk | null>(null)

  useEffect(() => {
    if (!paused) return
    let cancelled = false
    const read = (a: number, n: number) => debug.readMemoryRaw(a, n)
    ;(async () => {
      setBusy(true)
      setError(null)
      try {
        if (kind === 'rbtree') {
          const walk = await loadRbTree(read, addr, width)
          if (!cancelled) {
            setRb(walk)
            setError(walk.error)
          }
        } else if (kind === 'ring_buf') {
          const { ring: r, error: err } = await loadRingBuf(read, addr, width)
          if (!cancelled) {
            setRing(r)
            setError(err)
          }
        } else if (kind === 'sys_slist') {
          const walk = await loadSList(read, addr, width)
          if (!cancelled) {
            setSlist(walk)
            setError(walk.error)
          }
        } else if (kind === 'sys_dlist') {
          const walk = await loadDList(read, addr, width)
          if (!cancelled) {
            setDlist(walk)
            setError(walk.error)
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'decode failed')
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [kind, addr, width, paused])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" className="h-6 px-2 text-[10px]" onClick={onBackHex}>
          ← Hex
        </Button>
        {busy ? (
          <span className="font-mono text-[10px] text-muted-foreground">reading…</span>
        ) : null}
      </div>
      {error && !rb && !ring && !slist && !dlist ? (
        <p className="rounded-md bg-muted/40 px-2 py-3 font-mono text-[10px] text-muted-foreground">
          {error}
        </p>
      ) : null}
      {kind === 'rbtree' && rb ? <RbTreeView walk={rb} onPeek={onPeek} /> : null}
      {kind === 'ring_buf' && ring ? <RingBufView ring={ring} onPeek={onPeek} /> : null}
      {kind === 'sys_slist' && slist ? <SListView walk={slist} onPeek={onPeek} /> : null}
      {kind === 'sys_dlist' && dlist ? <DListView walk={dlist} onPeek={onPeek} /> : null}
    </div>
  )
}
