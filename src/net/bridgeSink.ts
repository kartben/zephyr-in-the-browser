/**
 * Net sink that rides the uber-bridge CH_NET channel (same WS as CTF/GDB).
 * Mirrors UplinkSink's surface so hostNet can swap either in.
 */

import { LanSniffer, type SniffState } from '@/net/sniff'
import {
  getDroppedTx,
  getSnapshot,
  isNetLive,
  resetDroppedTx,
  sendNetFrame,
  setNetHandler,
  subscribe,
  type BridgePhase,
} from '@/probe/client'
import type { UplinkHooks, UplinkPhase } from '@/net/uplink'

export class BridgeNetSink {
  readonly url: string
  phase: UplinkPhase = 'idle'
  detail = ''
  readonly counters = { droppedTx: 0, oversizeRx: 0, attempts: 0 }
  readonly sniffer = new LanSniffer()

  private readonly hooks: UplinkHooks
  private disposed = false
  private unsub: (() => void) | null = null

  constructor(url: string, hooks: UplinkHooks) {
    this.url = url
    this.hooks = hooks
  }

  get sniff(): SniffState {
    return this.sniffer.state
  }

  connect(): void {
    if (this.disposed) return
    resetDroppedTx()
    setNetHandler({
      deliverFrame: (frame) => {
        if (this.sniffer.onRx(frame)) this.hooks.onChange()
        this.hooks.deliverFrame(frame)
      },
      onPhaseChange: () => {
        this.syncPhase()
        this.hooks.onPhaseChange()
      },
    })
    this.unsub = subscribe(() => {
      const before = this.phase
      this.syncPhase()
      this.counters.droppedTx = getDroppedTx()
      this.counters.attempts = getSnapshot().attempts
      if (before !== this.phase) this.hooks.onPhaseChange()
      this.hooks.onChange()
    })
    this.syncPhase()
    this.hooks.onPhaseChange()
  }

  disconnect(): void {
    if (this.disposed) return
    setNetHandler(null)
    this.unsub?.()
    this.unsub = null
    this.phase = 'closed'
    this.detail = ''
    this.hooks.onPhaseChange()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    setNetHandler(null)
    this.unsub?.()
    this.unsub = null
  }

  tick(): void {}

  onGuestFrame(frame: Uint8Array): void {
    if (this.disposed) return
    if (this.sniffer.onTx(frame)) this.hooks.onChange()
    if (!sendNetFrame(frame)) {
      this.counters.droppedTx = getDroppedTx()
      this.hooks.onChange()
    }
  }

  private syncPhase() {
    const snap = getSnapshot()
    this.phase = mapPhase(snap.phase, snap.features?.net === true)
    this.detail =
      snap.phase === 'connected' && !snap.features?.net
        ? 'bridge has no network (passt unavailable)'
        : snap.detail
    this.counters.attempts = snap.attempts
    this.counters.droppedTx = getDroppedTx()
  }
}

function mapPhase(phase: BridgePhase, netOk: boolean): UplinkPhase {
  if (phase === 'connected') return netOk && isNetLive() ? 'connected' : 'connecting'
  if (phase === 'connecting') return 'connecting'
  if (phase === 'error') return 'error'
  if (phase === 'closed') return 'closed'
  return 'idle'
}
