/**
 * The Debug panel's Live board states. Attach is deliberately a button —
 * opening the GDB session halts the board — and daemon-side outcomes
 * (gdb-status) are narrated verbatim, because "target not examined" beats
 * a generic error.
 */

import { useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { runCommand } from '@/lib/commands'
import * as liveDebug from '@/debug/liveDebug'
import * as hostGdb from '@/hostGdb'
import type { GdbArch } from '@/debug/gdb/regs'

export function LiveDebugCard() {
  const snap = useSyncExternalStore(
    liveDebug.subscribe,
    liveDebug.getSnapshot,
    liveDebug.getSnapshot,
  )
  const [busy, setBusy] = useState(false)

  const attach = async () => {
    if (busy) return
    setBusy(true)
    try {
      await liveDebug.attach()
    } finally {
      setBusy(false)
    }
  }

  if (snap.bridgePhase !== 'connected') {
    return (
      <div className="space-y-2 px-3 py-4 text-[11px] text-muted-foreground">
        <p>Connect the desktop bridge in Settings to debug the live board.</p>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 text-xs"
          onClick={() => runCommand('open-settings')}
        >
          Open Settings
        </Button>
      </div>
    )
  }

  if (snap.phase === 'attaching') {
    return (
      <p className="px-3 py-4 text-[11px] text-muted-foreground">
        Attaching through the desktop bridge…
      </p>
    )
  }

  const server = snap.gdb ? `${snap.gdb.host}:${snap.gdb.port}` : 'its GDB server'
  return (
    <div className="space-y-2 px-3 py-4">
      {snap.phase === 'error' && (
        <>
          <p className="break-words font-mono text-[11px] text-destructive">{snap.detail}</p>
          <p className="text-[11px] text-muted-foreground">
            Is the GDB server running? Try <code className="font-mono">west debugserver</code>.
          </p>
        </>
      )}
      <Button size="sm" className="h-7 text-xs" onClick={() => void attach()} disabled={busy}>
        {snap.phase === 'error' ? 'Retry' : 'Attach'}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        GDB server at {server} (OpenOCD, J-Link, pyOCD). Attaching briefly halts the board.
      </p>
    </div>
  )
}

/** Above the run controls while attached: detach, plus degraded-mode helpers. */
export function LiveSessionStrip() {
  const gdb = useSyncExternalStore(hostGdb.subscribe, hostGdb.getSnapshot, hostGdb.getSnapshot)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Live board
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 text-[11px]"
          onClick={() => void liveDebug.detachSession()}
        >
          Detach
        </Button>
      </div>
      {!gdb.hasSymbols && (
        <div className="rounded-md border border-border bg-secondary/40 p-2 text-[11px] text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Drop the ELF you flashed</span> for
            symbols, threads and call stacks. Registers, memory and address breakpoints work
            without it.
          </p>
          <label className="mt-1.5 flex items-center gap-1.5">
            Registers decode as
            <select
              className="rounded border border-input bg-background px-1 py-0.5 font-mono text-[10px]"
              value={gdb.regArch ?? 'arm'}
              onChange={(event) => hostGdb.setLiveArch(event.target.value as GdbArch)}
              aria-label="Register layout"
            >
              <option value="arm">arm</option>
              <option value="aarch64">aarch64</option>
              <option value="riscv32">riscv32</option>
            </select>
          </label>
        </div>
      )}
    </div>
  )
}
