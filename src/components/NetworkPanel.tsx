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
} from '@/hostNet'
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
                ? 'via DHCP'
                : snapshot.dhcpState === 'static'
                  ? 'static'
                  : snapshot.dhcpState === 'offered'
                    ? 'DHCP offered…'
                    : 'waiting for the emulator'}
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
          {showAbout && <AboutThisNetwork />}
          <div className="grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[11px] text-muted-foreground">
            <span>mac</span>
            <span className="text-foreground">{snapshot.guestMac ?? '—'}</span>
            <span>gw</span>
            <span className="text-foreground">{snapshot.gatewayIp}</span>
            <span>dns</span>
            <span className="text-foreground">{snapshot.dnsIp}</span>
          </div>
        </Disclosure>

        <Disclosure title="Throughput" meta={formatBps(snapshot.txBps)} {...fold('throughput', true)}>
          <div className="space-y-2">
            <ThroughputRow label="TX" hint="emulator → browser" bps={snapshot.txBps} history={snapshot.txHistory} className="text-primary" />
            <ThroughputRow label="RX" hint="browser → emulator" bps={snapshot.rxBps} history={snapshot.rxHistory} className="text-success" />
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
            <Button size="sm" variant={snapshot.linkUp ? 'outline' : 'default'} className="mb-1 h-7 text-xs" onClick={() => setLink(!snapshot.linkUp)}>
              {snapshot.linkUp ? 'Drop link' : 'Raise link'}
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

        <Disclosure title="Capture" meta={snapshot.captureCount} {...fold('capture', false)}>
          <CaptureSection
            count={snapshot.captureCount}
            version={snapshot.captureVersion}
            paused={snapshot.capturePaused}
          />
        </Disclosure>

        <Disclosure title="Talk to the emulator" {...fold('tools', false)}>
          <ToolsSection guestIp={snapshot.guestIp} defaultUrl={guestHttpUrlFromDock()} />
        </Disclosure>
      </div>
  )
}

/**
 * The honest disclosure: what is real, what is theater. Same story as the
 * README's networking section — keep the two in step.
 */
function AboutThisNetwork() {
  return (
    <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 p-2 text-[11px] leading-relaxed">
      <p>
        <span className="font-medium">This network is the page.</span> Every frame the emulator
        sends lands in JavaScript, which answers as gateway, DHCP, DNS, and as every remote host. No
        packet reaches the real internet.
      </p>
      <p>
        <span className="font-medium text-success">Real:</span> DNS answers (looked up via
        DNS-over-HTTPS). HTTP the emulator sends to any host&apos;s :80/:8080, re-issued as a browser{' '}
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
        real hosts (browser pages have no sockets). Servers the emulator runs are reachable only
        through the GET and Browser tools below.
      </p>
      {/* The passt-uplink plan used to be a fifth paragraph here. A roadmap is
          not something the panel can act on — it belongs in the README. */}
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
            aria-label="URL to fetch from the emulator"
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
            aria-label="Payload to echo off the emulator"
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
          Tools unlock once the emulator has an IP address.
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
