/**
 * Live board debugging, orchestrated. App flips {@link setLiveMode} once per
 * document; the Debug panel's card drives {@link attach} / {@link detachSession};
 * this module owns everything between the bridge client and hostGdb — the
 * daemon-side proxy attach over ctrl, the RSP session over CH_GDB, symbols
 * from the dropped ELF, and recovery when the WebSocket drops mid-session.
 *
 * Attach is an explicit user gesture by design: opening the GDB session
 * halts the board (OpenOCD's gdb-attach event), so it must never be a side
 * effect of entering the mode.
 */

import * as bridge from '@/probe/client'
import * as hostGdb from '@/hostGdb'
import * as liveImage from '@/liveImage'
import { bridgeRspTransport } from '@/debug/gdb/bridgeTransport'
import { archFromElf } from '@/debug/gdb/regs'
import type { RspTransport } from '@/debug/gdb/rspTransport'
import type { GdbStatus } from '@/probe/protocol'
import type { BridgePhase } from '@/probe/client'

export type LiveDebugPhase = 'off' | 'idle' | 'attaching' | 'attached' | 'error'

export interface LiveDebugState {
  phase: LiveDebugPhase
  detail: string
  /** The daemon's view of its GDB server (host / port / phase). */
  gdb: GdbStatus | null
  bridgePhase: BridgePhase
  /** True when this page asked the daemon to dial, so detach hangs up too. */
  pageInitiated: boolean
}

const EMPTY: LiveDebugState = {
  phase: 'off',
  detail: '',
  gdb: null,
  bridgePhase: 'idle',
  pageInitiated: false,
}

const ATTACH_TIMEOUT_MS = 15_000

let state = EMPTY
let live = false
let transport: RspTransport | null = null
/** Breakpoint addresses saved across a bridge drop, re-planted on re-attach. */
let savedBreakpoints: number[] = []
let subscribed = false
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function set(partial: Partial<LiveDebugState>) {
  state = { ...state, ...partial }
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): LiveDebugState {
  return state
}

/** Bind hostGdb to the current symbol ELF (arch from e_machine when known). */
function bindFromImage() {
  const image = liveImage.get()
  hostGdb.bindLive(image ? archFromElf(image.bytes) : null)
  hostGdb.setKernelImage(image?.bytes ?? null)
}

function ensureSubscriptions() {
  if (subscribed) return
  subscribed = true

  // A later-dropped ELF upgrades the session in place: setKernelImage
  // republishes symbols/threads mid-attach, and the register decode follows
  // the ELF's machine when it names one this page can decode.
  liveImage.subscribe(() => {
    if (!live) return
    const image = liveImage.get()
    hostGdb.setKernelImage(image?.bytes ?? null)
    const arch = image ? archFromElf(image.bytes) : null
    if (arch) hostGdb.setLiveArch(arch)
  })

  bridge.subscribe(() => {
    if (!live) return
    const snap = bridge.getSnapshot()
    if (state.phase === 'attached' && snap.phase !== 'connected') {
      // The daemon keeps its TCP proxy to the GDB server across a page
      // WebSocket loss, so tear down locally, keep the parsed image, and
      // remember the breakpoints for a re-plant on the next attach.
      savedBreakpoints = hostGdb.getSnapshot().breakpoints.map((bp) => bp.addr)
      transport?.close?.()
      transport = null
      hostGdb.detachLive()
      set({
        phase: 'error',
        detail: 'Bridge connection lost. Breakpoints may still be armed on the probe.',
        gdb: snap.gdb,
        bridgePhase: snap.phase,
        pageInitiated: false,
      })
      return
    }
    set({ gdb: snap.gdb, bridgePhase: snap.phase })
  })
}

/** App calls this once per document; true only in Live board mode. */
export function setLiveMode(next: boolean): void {
  if (live === next) return
  live = next
  if (!next) {
    void detachSession()
    hostGdb.detach()
    state = EMPTY
    notify()
    return
  }
  ensureSubscriptions()
  bindFromImage()
  const snap = bridge.getSnapshot()
  set({ phase: 'idle', detail: '', gdb: snap.gdb, bridgePhase: snap.phase })
}

/**
 * Make sure the daemon holds an open proxy to its GDB server. Adopts a
 * TUI-initiated one as is (and leaves it up on detach — the TUI owns it);
 * otherwise asks the daemon to dial and waits for the gdb-status outcome.
 */
function ensureProxy(): Promise<void> {
  const current = bridge.getSnapshot().gdb
  if (current?.phase === 'connected') {
    set({ pageInitiated: false })
    return Promise.resolve()
  }
  set({ pageInitiated: true })
  bridge.attachGdb()
  return new Promise<void>((resolve, reject) => {
    // React only to fresh gdb-status notifications: the snapshot may still
    // hold a stale error from an earlier attempt, and the daemon rebroadcasts
    // (idle from its internal detach, then connected or error) on the way.
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for the GDB server'))
    }, ATTACH_TIMEOUT_MS)
    const unsubscribe = bridge.subscribe(() => {
      const gdb = bridge.getSnapshot().gdb
      if (gdb?.phase === 'connected') {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      } else if (gdb?.phase === 'error' || gdb?.phase === 'busy') {
        clearTimeout(timer)
        unsubscribe()
        reject(new Error(gdb.detail || 'the GDB server refused the connection'))
      }
    })
  })
}

/** The Attach button. Halts the board briefly; the session resumes it. */
export async function attach(): Promise<void> {
  if (!live || state.phase === 'attaching' || state.phase === 'attached') return
  if (bridge.getSnapshot().phase !== 'connected') {
    set({ phase: 'error', detail: 'Connect the desktop bridge first.' })
    return
  }
  set({ phase: 'attaching', detail: '' })
  try {
    await ensureProxy()
  } catch (err) {
    set({ phase: 'error', detail: err instanceof Error ? err.message : String(err) })
    return
  }
  const next = bridgeRspTransport({
    sendGdbBytes: bridge.sendGdbBytes,
    setGdbHandler: bridge.setGdbHandler,
  })
  transport = next
  const ok = await hostGdb.attachLiveSession(next)
  if (!ok) {
    next.close?.()
    if (transport === next) transport = null
    set({ phase: 'error', detail: 'The GDB server did not answer the RSP handshake.' })
    return
  }
  for (const addr of savedBreakpoints) {
    try {
      await hostGdb.addBreakpoint(addr)
    } catch {
      /* the board may have been reflashed; the panel shows what stuck */
    }
  }
  savedBreakpoints = []
  set({ phase: 'attached', detail: '' })
}

/** The Detach affordance and the mode-exit path. */
export async function detachSession(): Promise<void> {
  if (state.phase !== 'attached') return
  const wired = bridge.getSnapshot().phase === 'connected'
  if (wired) {
    try {
      // Clear our breakpoints from the probe (a closed page must not leave
      // them armed) and let the board go before walking away.
      for (const bp of hostGdb.getSnapshot().breakpoints) {
        await hostGdb.removeBreakpoint(bp.addr)
      }
      await hostGdb.resume()
    } catch {
      /* the wire may be mid-collapse; local teardown still applies */
    }
  }
  transport?.close?.()
  transport = null
  hostGdb.detachLive()
  if (state.pageInitiated && wired) bridge.detachGdb()
  savedBreakpoints = []
  set({ phase: 'idle', detail: '', pageInitiated: false })
}

export function _resetForTests(): void {
  transport?.close?.()
  transport = null
  live = false
  savedBreakpoints = []
  state = EMPTY
  notify()
}
