/**
 * The stage of a Live board session — takes the terminal's place. Walks from
 * "no bridge yet" to a streaming serial port, and holds the symbol-ELF card
 * the live debugger reads from. Connection config still lives in Settings;
 * the Connect button here drives the same singleton client.
 */

import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { CopyableCommand } from '@/components/CopyableCommand'
import { runCommand } from '@/lib/commands'
import { cn } from '@/lib/utils'
import {
  BRIDGE_GO_VERSION,
  BRIDGE_INSTALL_COMMAND,
  BRIDGE_RUN_COMMAND,
  getSettings,
  isValidBridgeUrl,
  resolveBridgeConfig,
  subscribe as subscribeBridgeSettings,
} from '@/lib/bridgeStore'
import * as bridge from '@/probe/client'
import * as liveImage from '@/liveImage'

export function LiveBoardHome({ errorDetail }: { errorDetail?: string | null }) {
  useSyncExternalStore(subscribeBridgeSettings, getSettings, getSettings)
  const snap = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
  const elf = useSyncExternalStore(liveImage.subscribe, liveImage.get, liveImage.get)

  const cfg = resolveBridgeConfig()
  const configured = cfg.enabled && isValidBridgeUrl(cfg.url)
  const { phase, detail, serial, ports } = snap
  const streaming = phase === 'connected' && serial?.phase === 'streaming'

  const dot = streaming
    ? 'bg-success'
    : phase === 'connected'
      ? 'bg-warning'
      : phase === 'connecting'
        ? 'bg-warning animate-pulse'
        : phase === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground'

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto">
      <div className="mt-6 w-full max-w-md space-y-3">
        <section className="space-y-2 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Live board</h2>
            {configured && (
              <>
                <span
                  className={cn('size-2 shrink-0 rounded-full', dot)}
                  role="status"
                  aria-label={`Bridge ${phase}`}
                />
                <span className="font-mono text-[11px]">{phase}</span>
              </>
            )}
          </div>

          {!configured && (
            <div className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <p>
                Connect a real board through the desktop bridge — a small program you run on your
                own machine.
              </p>
              <p className="text-foreground">Install it with Go {BRIDGE_GO_VERSION} or newer:</p>
              <CopyableCommand command={BRIDGE_INSTALL_COMMAND} />
              <p className="text-foreground">Then start it:</p>
              <CopyableCommand command={BRIDGE_RUN_COMMAND} />
              <p>
                Open the link the bridge prints, or paste its URL in Settings and Connect.
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-xs"
                onClick={() => runCommand('open-settings')}
              >
                Open Settings
              </Button>
            </div>
          )}

          {configured && phase === 'error' && detail && (
            <p className="break-words font-mono text-[11px] text-destructive">{detail}</p>
          )}

          {configured && !streaming && phase !== 'connected' && (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs"
              onClick={() => bridge.connect()}
              disabled={phase === 'connecting'}
            >
              {phase === 'connecting' ? 'Connecting…' : phase === 'error' ? 'Retry' : 'Connect'}
            </Button>
          )}

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

          {streaming && (
            <p className="text-[11px] text-muted-foreground">
              Streaming from <span className="font-mono">{serial?.path}</span>. Traces appear in
              the Trace panel.
            </p>
          )}
        </section>

        <section className="space-y-1.5 rounded-lg border border-border bg-card p-4">
          <h3 className="text-xs font-semibold">Debug symbols</h3>
          {elf ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate font-mono text-[11px]" title={elf.name}>
                {elf.name}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 shrink-0 text-[11px]"
                onClick={() => void liveImage.clear()}
              >
                Clear
              </Button>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Drop the ELF you flashed anywhere on the page to load debug symbols.
            </p>
          )}
        </section>

        {errorDetail && (
          <p className="break-words px-1 font-mono text-[11px] text-destructive">{errorDetail}</p>
        )}
      </div>
    </div>
  )
}
