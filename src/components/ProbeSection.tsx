/**
 * The Trace panel's serial-port strip for Live board sessions: connection
 * state and port picking at the point of use. Rendered only in live mode
 * (TraceBody gates it); onboarding an unconfigured bridge is the Live board
 * home surface's job, so this stays quiet until Settings has a bridge.
 */

import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  getSettings as getBridgeSettings,
  resolveBridgeConfig,
  subscribe as subscribeBridgeSettings,
} from '@/lib/bridgeStore'
import * as bridge from '@/probe/client'

export function ProbeSection() {
  useSyncExternalStore(subscribeBridgeSettings, getBridgeSettings, getBridgeSettings)
  const snap = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
  const enabled = resolveBridgeConfig().enabled

  if (!enabled) return null

  const { phase, detail, serial, ports } = snap
  const dot =
    phase === 'connected'
      ? serial?.phase === 'streaming'
        ? 'bg-success'
        : 'bg-warning'
      : phase === 'connecting'
        ? 'bg-warning animate-pulse'
        : phase === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground'

  return (
    <div className="space-y-2 border-b border-border/60 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">Live board</span>
        <span
          className={cn('size-2 shrink-0 rounded-full', dot)}
          role="status"
          aria-label={`Bridge ${phase}`}
        />
        <span className="font-mono text-[11px]">{phase}</span>
        {serial?.phase === 'streaming' && serial.path && (
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={serial.path}>
            {serial.path}
          </span>
        )}
        {detail && phase === 'error' && (
          <span className="truncate font-mono text-[11px] text-destructive" title={detail}>
            {detail}
          </span>
        )}
      </div>

      {phase === 'connected' && ports.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {ports.map((p) => {
            const active = serial?.path === p.path && serial.phase === 'streaming'
            return (
              <Button
                key={p.path}
                size="sm"
                variant={active ? 'default' : 'outline'}
                className="h-7 max-w-full truncate font-mono text-[10px]"
                title={p.friendlyName}
                onClick={() =>
                  active
                    ? bridge.stopSerial()
                    : bridge.selectSerial(p.path, serial?.baudRate ?? 115200)
                }
              >
                {p.path}
              </Button>
            )
          })}
        </div>
      )}

      {phase === 'connected' && ports.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          Waiting for a serial port. Plug in a board, or pick a port when the bridge lists one.
        </p>
      )}

      {(phase === 'idle' || phase === 'connecting') && (
        <p className="text-[11px] text-muted-foreground">
          Bridge URL is set in Settings. Connect there if the status stays idle.
        </p>
      )}
    </div>
  )
}
