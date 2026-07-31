/**
 * Top-bar Settings: one place to configure the desktop bridge.
 * Copy for Zephyr learners — keep clutter low (tooltips over subtitles).
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Info, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyableCommand } from '@/components/CopyableCommand'
import { registerCommand } from '@/lib/commands'
import { getMode, subscribe as subscribeMode } from '@/lib/modeStore'
import { cn } from '@/lib/utils'
import {
  BRIDGE_GO_VERSION,
  BRIDGE_INSTALL_COMMAND,
  BRIDGE_QUERY_PARAM,
  BRIDGE_RUN_COMMAND,
  getSettings,
  isValidBridgeUrl,
  mixedContentHint,
  resolveBridgeConfig,
  setEnabled,
  setUrl,
  subscribe,
} from '@/lib/bridgeStore'
import * as bridge from '@/probe/client'

export function SettingsMenu() {
  const [open, setOpen] = useState(false)
  const settings = useSyncExternalStore(subscribe, getSettings, getSettings)
  const snap = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
  const mode = useSyncExternalStore(subscribeMode, getMode, getMode)
  const [url, setUrlLocal] = useState(settings.url)
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => {
    setUrlLocal(settings.url)
  }, [settings.url])

  // The Live board home surface deep-links here ("Open Settings").
  useEffect(() => registerCommand('open-settings', () => setOpen(true)), [])

  const resolved = resolveBridgeConfig()
  const queryForced = resolved.source === 'query'
  const urlInvalid = url.trim() !== '' && !isValidBridgeUrl(url.trim())
  const wsHint = settings.enabled ? mixedContentHint(url.trim()) : ''

  const commitUrl = () => {
    const next = url.trim()
    if (next === '' || isValidBridgeUrl(next)) setUrl(next)
  }

  const phase = snap.phase
  const dot =
    phase === 'connected'
      ? 'bg-success'
      : phase === 'connecting'
        ? 'bg-warning animate-pulse'
        : phase === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground'

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        className={cn('size-8', open && 'bg-accent')}
        aria-label="Settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <Settings className="size-4" />
      </Button>

      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default"
            aria-label="Dismiss settings"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Settings"
            className="absolute right-0 top-full z-50 mt-1 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-card p-3 shadow-xl"
          >
            <div className="mb-2 flex items-center gap-1.5">
              <h2 className="text-sm font-semibold">Desktop bridge</h2>
              <Button
                variant="ghost"
                size="icon"
                className={cn('ml-auto size-6', showHelp && 'text-primary')}
                aria-label="How to install and run the bridge"
                aria-pressed={showHelp}
                onClick={() => setShowHelp((s) => !s)}
              >
                <Info className="size-3.5" />
              </Button>
            </div>

            {showHelp && (
              <div className="mb-2 space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2 text-[11px] leading-relaxed">
                <p>
                  The desktop bridge is a small program you run on your own machine. In Live board
                  mode it streams traces from a real board. In Simulator mode it can carry the
                  guest's network (Bridge network).
                </p>
                <p>Install it with Go {BRIDGE_GO_VERSION} or newer:</p>
                <CopyableCommand command={BRIDGE_INSTALL_COMMAND} />
                <p>Then start it and paste the URL it prints:</p>
                <CopyableCommand command={BRIDGE_RUN_COMMAND} />
                <p>
                  Full notes in{' '}
                  <a
                    className="underline decoration-dotted underline-offset-2 hover:text-primary"
                    href="https://github.com/kartben/zephyr-in-the-browser/blob/main/docs/bridge.md"
                    target="_blank"
                    rel="noreferrer"
                  >
                    docs/bridge.md
                  </a>
                  .
                </p>
              </div>
            )}

            <label className="mb-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={settings.enabled}
                disabled={queryForced}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Use desktop bridge
            </label>

            <span className="flex min-w-0 items-center rounded-md border border-input bg-background px-2">
              <input
                type="text"
                aria-label="Bridge WebSocket URL"
                placeholder="ws://localhost:8740/?token=…"
                value={url}
                disabled={queryForced}
                onChange={(e) => setUrlLocal(e.target.value)}
                onBlur={commitUrl}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitUrl()
                }}
                className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
              />
            </span>
            {urlInvalid && (
              <p className="mt-1 font-mono text-[11px] text-destructive">not a ws:// or wss:// URL</p>
            )}
            {!urlInvalid && wsHint && (
              <p className="mt-1 text-[11px] text-muted-foreground">{wsHint}</p>
            )}

            {queryForced && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Set by <code className="font-mono">?{BRIDGE_QUERY_PARAM}=</code>. Remove it to edit
                here.
              </p>
            )}

            {settings.enabled && (
              <div className="mt-2 flex items-center gap-1.5">
                <span
                  className={cn('size-2 shrink-0 rounded-full', dot)}
                  role="status"
                  aria-label={`Bridge ${phase}`}
                />
                <span className="font-mono text-[11px]">{phase}</span>
                {snap.features && (
                  <span className="truncate text-[10px] text-muted-foreground">
                    {[
                      snap.features.ctf && 'tracing',
                      snap.features.net && 'network',
                      snap.features.gdb && 'debug',
                    ]
                      .filter(Boolean)
                      .join(' · ') || '…'}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto h-7 shrink-0 text-xs"
                  onClick={() =>
                    phase === 'connected' || phase === 'connecting'
                      ? bridge.disconnect()
                      : bridge.connect()
                  }
                >
                  {phase === 'connected' || phase === 'connecting'
                    ? 'Disconnect'
                    : phase === 'error'
                      ? 'Retry'
                      : 'Connect'}
                </Button>
              </div>
            )}

            {settings.enabled && phase === 'connected' && snap.serial?.phase === 'streaming' && (
              <p
                className="mt-1 truncate text-[10px] text-muted-foreground"
                title={snap.serial.path ?? undefined}
              >
                Streaming from {snap.serial.path}
              </p>
            )}

            {settings.enabled && phase === 'connected' && mode === 'sim' && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                Board traces show in Live board mode. Use the switch in the top bar.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
