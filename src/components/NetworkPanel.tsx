import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Download, Globe, Info, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SliderControl } from '@/components/controls/ControlRow'
import { Disclosure } from '@/components/dock/Disclosure'
import { GuestBrowserDialog } from '@/components/GuestBrowserDialog'
import { Sparkline } from '@/components/Sparkline'
import { cn } from '@/lib/utils'
import {
  getState as getDockState,
  sectionOpenIn,
  setSection,
  subscribe as subscribeDock,
} from '@/lib/dockStore'
import {
  buildPcapBlob,
  clearCapture,
  echoToGuest,
  getCaptures,
  getSnapshot,
  httpGetFromHost,
  pauseCapture,
  setImpairments,
  setLink,
  subscribe,
  uplinkConnect,
  uplinkDisconnect,
  type NetSnapshot,
} from '@/hostNet'
import {
  getSettings as getNetSettings,
  isValidGatewayUrl,
  resolveNetConfig,
  setMode as setNetMode,
  setUrl as setNetUrl,
  subscribe as subscribeNet,
  NET_QUERY_PARAM,
} from '@/lib/netStore'
import {
  getSettings as getBridgeSettings,
  isValidBridgeUrl,
  subscribe as subscribeBridge,
} from '@/lib/bridgeStore'
import { mixedContentHint } from '@/net/uplink'
import { getBoard, getSample } from '@/boards'

const DEFAULT_GUEST_HTTP_URL = 'http://192.0.2.1/'

/** Resolve the Network GET default from the dock's current board:sample seed. */
function guestHttpUrlFromDock(): string {
  const seededFor = getDockState().seededFor
  const [boardId, sampleId] = seededFor.split(':')
  if (!boardId || !sampleId || boardId === 'custom') return DEFAULT_GUEST_HTTP_URL
  try {
    return getSample(getBoard(boardId), sampleId).guestHttpUrl ?? DEFAULT_GUEST_HTTP_URL
  } catch {
    return DEFAULT_GUEST_HTTP_URL
  }
}

/**
 * The cockpit without the frame, shared by the dock row and the floating
 * window: five disclosures over one column — status and throughput open by
 * default, link/impairments, capture and tools folded until wanted. The open
 * set persists per device in dockStore, so it survives reloads, view flips
 * and pop-outs alike. The "About this network" toggle lives inline with the
 * IP — a body has no header to put it in.
 */
export function NetworkBody({ sectionsKey = 'net' }: { sectionsKey?: string }) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const dock = useSyncExternalStore(subscribeDock, getDockState, getDockState)
  const [showAbout, setShowAbout] = useState(false)

  const openOf = (id: string, fallback: boolean) => sectionOpenIn(dock, sectionsKey, id, fallback)
  const fold = (id: string, fallback: boolean) => ({
    open: openOf(id, fallback),
    onToggle: () => setSection(sectionsKey, id, !openOf(id, fallback)),
  })

  return (
      <div className="space-y-0.5 px-3 py-2.5">
        <Disclosure title="Status" meta={snapshot.guestIp ?? '—'} {...fold('status', true)}>
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-lg font-semibold tabular-nums">
              {snapshot.guestIp ?? '—'}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {snapshot.dhcpState === 'bound'
                ? snapshot.mode === 'uplink'
                  ? 'via Bridge network DHCP'
                  : 'via DHCP'
                : snapshot.dhcpState === 'static'
                  ? 'static'
                  : snapshot.dhcpState === 'offered'
                    ? 'DHCP offered…'
                    : 'waiting for the guest'}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className={cn('ml-auto size-6 self-center', showAbout && 'text-primary')}
              aria-label="How this network works"
              aria-pressed={showAbout}
              onClick={() => setShowAbout((s) => !s)}
            >
              <Info className="size-3.5" />
            </Button>
          </div>
          {showAbout && <AboutThisNetwork mode={snapshot.mode} />}
          <div className="grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[11px] text-muted-foreground">
            <span>mac</span>
            <span className="text-foreground">{snapshot.guestMac ?? '—'}</span>
            <span>gw</span>
            <span className="text-foreground">{snapshot.gatewayIp ?? '—'}</span>
            <span>dns</span>
            <span className="text-foreground">{snapshot.dnsIp ?? '—'}</span>
          </div>
        </Disclosure>

        <Disclosure title="Throughput" meta={formatBps(snapshot.txBps)} {...fold('throughput', true)}>
          <div className="space-y-2">
            <ThroughputRow label="TX" hint="guest → browser" bps={snapshot.txBps} history={snapshot.txHistory} className="text-primary" />
            <ThroughputRow label="RX" hint="browser → guest" bps={snapshot.rxBps} history={snapshot.rxHistory} className="text-success" />
            <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
              ↑ {snapshot.txPackets} pkts · {formatBytes(snapshot.txBytes)}
              {'   '}↓ {snapshot.rxPackets} pkts · {formatBytes(snapshot.rxBytes)}
            </p>
          </div>
        </Disclosure>

        <Disclosure
          title="Link & impairments"
          meta={snapshot.linkUp ? undefined : 'down'}
          {...fold('link', false)}
        >
          <div className="space-y-1">
            <Button size="sm" variant={snapshot.userLinkUp ? 'outline' : 'default'} className="mb-1 h-7 text-xs" onClick={() => setLink(!snapshot.userLinkUp)}>
              {snapshot.userLinkUp ? 'Drop link' : 'Raise link'}
            </Button>
            <SliderControl
              label="Added latency"
              value={snapshot.impairments.delayMs}
              unit="ms"
              min={0}
              max={500}
              step={10}
              format={(v) => String(Math.round(v))}
              onChange={(delayMs) => setImpairments({ delayMs })}
            />
            <SliderControl
              label="Packet loss"
              value={snapshot.impairments.lossPct}
              unit="%"
              min={0}
              max={20}
              step={1}
              format={(v) => String(Math.round(v))}
              onChange={(lossPct) => setImpairments({ lossPct })}
            />
          </div>
        </Disclosure>

        <Disclosure
          title="Uplink"
          meta={snapshot.mode === 'uplink' ? snapshot.uplink.phase : undefined}
          {...fold('uplink', false)}
        >
          <UplinkSection snapshot={snapshot} />
        </Disclosure>

        <Disclosure title="Capture" meta={snapshot.captureCount} {...fold('capture', false)}>
          <CaptureSection
            count={snapshot.captureCount}
            version={snapshot.captureVersion}
            paused={snapshot.capturePaused}
          />
        </Disclosure>

        <Disclosure title="Talk to the guest" {...fold('tools', false)}>
          {snapshot.mode === 'uplink' ? (
            <p className="text-[11px] text-muted-foreground">
              Not available with Bridge network. GET, Browser, and echo use the simulated LAN.
              Reach servers the guest runs with port forwards on the bridge host. Open ⓘ under
              Uplink for how.
            </p>
          ) : (
            <ToolsSection guestIp={snapshot.guestIp} defaultUrl={guestHttpUrlFromDock()} />
          )}
        </Disclosure>
      </div>
  )
}

/**
 * The honest disclosure: what is real, what is theater. Same story as the
 * README's networking section and docs/networking.md — keep them in step.
 */
function AboutThisNetwork({ mode }: { mode: 'sim' | 'uplink' }) {
  if (mode === 'uplink') {
    return (
      <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2 text-[11px] leading-relaxed">
        <p>
          <span className="font-medium">This network leaves the page.</span> Every frame the guest
          sends goes to the desktop bridge (or a net-only gateway URL), which answers with real
          DHCP, DNS, TCP/UDP, and ICMP from its own network.
        </p>
        <p>
          <span className="font-medium text-success">Real:</span> DHCP leases, DNS, HTTPS, raw
          TCP/UDP, even ping. Everything the bridge host can reach.
        </p>
        <p>
          <span className="font-medium text-warning">Simulated:</span> nothing in the page.
          Capture, throughput, and impairments still watch the same wire.
        </p>
        <p>
          <span className="font-medium text-destructive">Impossible:</span> the panel&apos;s GET,
          Browser, and echo tools, which dial in through the simulated LAN. Use port forwards on
          the bridge host to reach servers the guest runs.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2 text-[11px] leading-relaxed">
      <p>
        <span className="font-medium">This network is the page.</span> Every frame the guest
        sends lands in JavaScript, which answers as gateway, DHCP, DNS, and as every remote host. No
        packet reaches the real internet.
      </p>
      <p>
        <span className="font-medium text-success">Real:</span> DNS answers (looked up via
        DNS-over-HTTPS). HTTP the guest sends to any host&apos;s :80/:8080, re-issued as a browser{' '}
        <code className="font-mono">fetch()</code>. CORS decides what is readable;{' '}
        <code className="font-mono">host.internal</code> always works.
      </p>
      <p>
        <span className="font-medium text-warning">Simulated:</span> ping replies (every address
        &quot;answers&quot; because the page does, not the host). SNTP (your browser&apos;s clock).
        The echo and zperf peers at 192.0.2.x.
      </p>
      <p>
        <span className="font-medium text-destructive">Impossible:</span> HTTPS or raw TCP/UDP to
        real hosts (browser pages have no sockets). Servers the guest runs are reachable only
        through the GET and Browser tools below, or for real with Bridge network under Uplink.
      </p>
    </div>
  )
}

/**
 * Mode + gateway URL + live connection state. The mode/URL edits land in
 * netStore immediately but only apply at the next emulator start (a running
 * guest holds its lease; swapping LANs under it would lie) — the section
 * says so whenever the stored choice differs from what this session runs.
 */

function UplinkSection({ snapshot }: { snapshot: NetSnapshot }) {
  const settings = useSyncExternalStore(subscribeNet, getNetSettings, getNetSettings)
  const bridgeSettings = useSyncExternalStore(
    subscribeBridge,
    getBridgeSettings,
    getBridgeSettings,
  )
  const [url, setUrlLocal] = useState(settings.url)
  const [showHelp, setShowHelp] = useState(false)
  useEffect(() => {
    setUrlLocal(settings.url)
  }, [settings.url])

  const resolved = resolveNetConfig()
  const queryForced = resolved.source === 'query'
  const usingBridge = bridgeSettings.enabled && isValidBridgeUrl(bridgeSettings.url)
  const urlInvalid =
    !usingBridge && url.trim() !== '' && !isValidGatewayUrl(url.trim())
  const running = snapshot.available
  const runningUplink = running && snapshot.mode === 'uplink'
  const pendingRestart =
    running &&
    (resolved.mode !== snapshot.mode ||
      (resolved.mode === 'uplink' &&
        snapshot.mode === 'uplink' &&
        resolved.url !== snapshot.uplink.url))
  const wsHint =
    settings.mode === 'uplink' && !usingBridge ? mixedContentHint(url.trim()) : ''

  const commitUrl = () => {
    const next = url.trim()
    if (next === '' || isValidGatewayUrl(next)) setNetUrl(next)
  }

  const { phase, detail, attempts, droppedTx, oversizeRx } = snapshot.uplink
  const dot =
    phase === 'connected'
      ? 'bg-success'
      : phase === 'connecting'
        ? 'bg-warning animate-pulse'
        : phase === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={settings.mode === 'sim' ? 'default' : 'outline'}
          className="h-7 text-xs"
          disabled={queryForced}
          onClick={() => setNetMode('sim')}
        >
          Simulated LAN
        </Button>
        <Button
          size="sm"
          variant={settings.mode === 'uplink' ? 'default' : 'outline'}
          className="h-7 text-xs"
          disabled={queryForced}
          onClick={() => setNetMode('uplink')}
        >
          Bridge network
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn('ml-auto size-6', showHelp && 'text-primary')}
          aria-label="How Bridge network works"
          aria-pressed={showHelp}
          onClick={() => setShowHelp((s) => !s)}
        >
          <Info className="size-3.5" />
        </Button>
      </div>

      {showHelp && (
        <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2 text-[11px] leading-relaxed">
          <p>
            <span className="font-medium">Bridge network</span> sends the guest&apos;s Ethernet
            frames through the desktop bridge from Settings. Trace Live board can share the same
            connection.
          </p>
          <p>
            Open Settings (gear in the top bar), turn on the desktop bridge, paste the URL it
            prints, Connect, then restart the guest (⟳).
          </p>
          <p>
            If Settings is off, you can still paste a net-only gateway URL below. See{' '}
            <a
              className="underline decoration-dotted underline-offset-2 hover:text-primary"
              href="https://github.com/kartben/zephyr-in-the-browser/blob/main/docs/bridge.md"
              target="_blank"
              rel="noreferrer"
            >
              docs/bridge.md
            </a>{' '}
            for how to run the bridge.
          </p>
        </div>
      )}

      {settings.mode === 'uplink' && usingBridge && (
        <p className="text-[11px] text-muted-foreground">
          Using Settings → Desktop bridge. Restart the guest (⟳) after you change Settings.
        </p>
      )}

      {settings.mode === 'uplink' && !usingBridge && (
        <span className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-background px-2">
          <input
            type="text"
            aria-label="Gateway WebSocket URL"
            placeholder="ws://localhost:8737/?token=…"
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
      )}
      {urlInvalid && (
        <p className="font-mono text-[11px] text-destructive">not a ws:// or wss:// URL</p>
      )}
      {!urlInvalid && wsHint && <p className="text-[11px] text-muted-foreground">{wsHint}</p>}

      {queryForced && (
        <p className="text-[11px] text-muted-foreground">
          Set by the <code className="font-mono">?{NET_QUERY_PARAM}=</code> URL parameter. Remove
          it to use this panel&apos;s setting.
        </p>
      )}

      {runningUplink && (
        <div className="flex items-center gap-1.5">
          <span className={cn('size-2 shrink-0 rounded-full', dot)} role="status" aria-label={`Bridge network ${phase}`} />
          <span className="shrink-0 font-mono text-[11px]">{phase}</span>
          {detail && (
            <span
              className={cn(
                'truncate font-mono text-[11px]',
                phase === 'error' ? 'text-destructive' : 'text-muted-foreground',
              )}
              title={detail}
            >
              {detail}
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto h-7 shrink-0 text-xs"
            onClick={() =>
              phase === 'connected' || phase === 'connecting' ? uplinkDisconnect() : uplinkConnect()
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
      {runningUplink && (droppedTx > 0 || oversizeRx > 0 || attempts > 1) && (
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
          dropped {droppedTx} · oversize {oversizeRx} · attempts {attempts}
        </p>
      )}

      {pendingRestart && (
        <p className="text-[11px] text-muted-foreground">
          Applies after the guest restarts (⟳ in the top bar).
        </p>
      )}
    </div>
  )
}

function ThroughputRow({
  label,
  hint,
  bps,
  history,
  className,
}: {
  label: string
  hint: string
  bps: number
  history: readonly number[]
  className?: string
}) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium">
          {label} <span className="font-normal text-muted-foreground">{hint}</span>
        </span>
        <span className="font-mono text-xs tabular-nums">{formatBps(bps)}</span>
      </div>
      <Sparkline values={history} height={28} className="mt-1" ariaLabel={`${label} throughput history`} />
    </div>
  )
}

const PROTO_TINT: Record<string, string> = {
  ARP: 'text-warning',
  DHCP: 'text-warning',
  DNS: 'text-primary',
  ICMP: 'text-success',
  TCP: 'text-primary',
  HTTP: 'text-success',
  UDP: 'text-foreground',
  SNTP: 'text-foreground',
}

function CaptureSection({ count, version, paused }: { count: number; version: number; paused: boolean }) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [version])

  const entries = getCaptures()
  const visible = entries.slice(-100)
  const firstTs = entries.length > 0 ? entries[0].ts : 0

  const download = () => {
    const url = URL.createObjectURL(buildPcapBlob())
    const a = document.createElement('a')
    a.href = url
    a.download = `zephyr-net-${new Date().toISOString().replace(/[:.]/g, '-')}.pcap`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        {/* Title and count live on the disclosure header now; just the tools. */}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={paused ? 'Resume capture' : 'Pause capture'}
            onClick={() => pauseCapture(!paused)}
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="size-6" aria-label="Clear capture" onClick={clearCapture}>
            <Trash2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Download capture as pcap"
            disabled={count === 0}
            onClick={download}
          >
            <Download className="size-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={listRef}
        onScroll={() => {
          const el = listRef.current
          if (el) stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
        }}
        className="max-h-36 space-y-px overflow-y-auto rounded-md border border-border bg-background/50 p-1 font-mono text-[10px] leading-4"
      >
        {visible.length === 0 && <p className="px-1 py-2 text-muted-foreground">No frames yet.</p>}
        {visible.map((entry) => (
          <div key={entry.id} className="flex gap-1 whitespace-nowrap px-1">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              +{((entry.ts - firstTs) / 1000).toFixed(3)}
            </span>
            <span className={cn('shrink-0', entry.dir === 'tx' ? 'text-primary' : 'text-success')}>
              {entry.dir === 'tx' ? '↑' : '↓'}
            </span>
            <span className={cn('shrink-0 font-semibold', PROTO_TINT[entry.proto] ?? 'text-muted-foreground')}>
              {entry.proto}
            </span>
            <span className="overflow-hidden text-ellipsis text-foreground/90" title={entry.summary}>
              {entry.summary}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolsSection({
  guestIp,
  defaultUrl,
}: {
  guestIp: string | null
  defaultUrl: string
}) {
  // Re-seed when the running sample changes (dumb_http_server :8080 vs
  // http_server :80). subscribeDock keeps us honest if the panel stays mounted.
  const seededUrl = useSyncExternalStore(
    subscribeDock,
    guestHttpUrlFromDock,
    () => defaultUrl,
  )
  const [url, setUrl] = useState(seededUrl)
  const [httpBusy, setHttpBusy] = useState(false)
  const [httpResult, setHttpResult] = useState<string | null>(null)
  const [httpError, setHttpError] = useState<string | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)

  useEffect(() => {
    setUrl(seededUrl)
  }, [seededUrl])

  const [echoText, setEchoText] = useState('Hello Zephyr!')
  const [echoResult, setEchoResult] = useState<string | null>(null)
  const [echoError, setEchoError] = useState<string | null>(null)

  // The GET tool works with an explicit IP before the guest is learned (the
  // wire broadcasts, and the guest's reply teaches the stack); echo has no
  // address of its own to fall back on.
  const ready = guestIp !== null
  const urlHasIp = /^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(url)
  const getReady = ready || urlHasIp

  const runHttpGet = async () => {
    setHttpBusy(true)
    setHttpResult(null)
    setHttpError(null)
    try {
      const res = await httpGetFromHost(url)
      setHttpResult(`HTTP ${res.status} ${res.statusText}\n${res.text.slice(0, 2000)}`)
    } catch (error) {
      setHttpError(error instanceof Error ? error.message : String(error))
    } finally {
      setHttpBusy(false)
    }
  }

  const runEcho = async (proto: 'tcp' | 'udp') => {
    setEchoResult(null)
    setEchoError(null)
    try {
      setEchoResult(await echoToGuest(echoText, proto))
    } catch (error) {
      setEchoError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-background px-2">
          <input
            type="text"
            aria-label="URL to fetch from the guest"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && getReady && !httpBusy) void runHttpGet()
            }}
            className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[11px] text-foreground outline-none"
          />
        </span>
        <Button size="sm" className="h-7 text-xs" disabled={!getReady || httpBusy} onClick={() => void runHttpGet()}>
          GET
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 gap-1 text-xs"
          disabled={!getReady}
          onClick={() => setBrowserOpen(true)}
        >
          <Globe className="size-3" aria-hidden />
          Browser
        </Button>
      </div>
      {(httpResult || httpError) && (
        <pre
          className={cn(
            'max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/50 p-1.5 font-mono text-[10px] leading-4',
            httpError && 'text-destructive',
          )}
        >
          {httpError ?? httpResult}
        </pre>
      )}

      <GuestBrowserDialog open={browserOpen} onOpenChange={setBrowserOpen} initialUrl={url} />

      <div className="flex items-center gap-1.5">
        <span className="flex min-w-0 flex-1 items-center rounded-md border border-input bg-background px-2">
          <input
            type="text"
            aria-label="Payload to echo off the guest"
            value={echoText}
            onChange={(e) => setEchoText(e.target.value)}
            className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[11px] text-foreground outline-none"
          />
        </span>
        <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={!ready} onClick={() => void runEcho('tcp')}>
          TCP
        </Button>
        <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={!ready} onClick={() => void runEcho('udp')}>
          UDP
        </Button>
      </div>
      {(echoResult || echoError) && (
        <p className={cn('font-mono text-[11px]', echoError ? 'text-destructive' : 'text-success')}>
          {echoError ?? `← ${echoResult}`}
        </p>
      )}
      {!ready && (
        <p className="text-[11px] text-muted-foreground">
          Tools unlock once the guest has an IP address.
        </p>
      )}
    </div>
  )
}

function formatBps(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mb/s`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kb/s`
  return `${Math.round(bps)} b/s`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`
  return `${bytes} B`
}
