/**
 * Trace → Live board: uses the desktop bridge from Settings (no second URL).
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

  if (!enabled) {
    return (
      <div className="space-y-1 border-b border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Live board</span>
        <p>
          Turn on the desktop bridge in Settings to stream traces from a real board. No guest
          image required.
        </p>
      </div>
    )
  }

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
