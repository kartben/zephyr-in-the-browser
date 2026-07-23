import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Download, Info, Network, Pause, Play, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sparkline } from '@/components/Sparkline'
import { cn } from '@/lib/utils'
import {
  available,
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

/**
 * The Ethernet bridge's cockpit: interface status, live RX/TX throughput,
 * link + impairment controls, a tcpdump-style capture with .pcap export, and
 * client tools that dial INTO servers the guest runs. Everything rides
 * src/hostNet.ts and the src/net/ stack — the panel is pure presentation.
 */
export function NetworkPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)
  const [showImpairments, setShowImpairments] = useState(false)
  const [showAbout, setShowAbout] = useState(false)

  if (!snapshot.available || !available() || dismissed) return null

  return (
    <div className="pointer-events-auto w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div className={cn('flex items-center gap-2 px-3 py-2', !collapsed && 'border-b border-border')}>
        <Network className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">Network</span>
        <span
          className={cn('size-2 rounded-full', snapshot.linkUp ? 'bg-success' : 'bg-destructive')}
          role="status"
          aria-label={snapshot.linkUp ? 'Link up' : 'Link down'}
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={cn('size-6', showAbout && 'text-primary')}
            aria-label="How this network works"
            aria-pressed={showAbout}
            onClick={() => {
              setShowAbout((s) => !s)
              setCollapsed(false)
            }}
          >
            <Info className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? 'Expand network panel' : 'Collapse network panel'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide network panel"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="max-h-[min(30rem,65vh)] space-y-3 overflow-y-auto px-3 py-3">
          {showAbout && <AboutThisNetwork />}
          {/* Interface status */}
          <div className="space-y-1">
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
                      : 'waiting for the guest'}
              </span>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[11px] text-muted-foreground">
              <span>mac</span>
              <span className="text-foreground">{snapshot.guestMac ?? '—'}</span>
              <span>gw</span>
              <span className="text-foreground">{snapshot.gatewayIp}</span>
              <span>dns</span>
              <span className="text-foreground">{snapshot.dnsIp}</span>
            </div>
          </div>

          {/* Throughput */}
          <div className="space-y-2">
            <ThroughputRow label="TX" hint="guest → browser" bps={snapshot.txBps} history={snapshot.txHistory} className="text-primary" />
            <ThroughputRow label="RX" hint="browser → guest" bps={snapshot.rxBps} history={snapshot.rxHistory} className="text-success" />
            <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
              ↑ {snapshot.txPackets} pkts · {formatBytes(snapshot.txBytes)}
              {'   '}↓ {snapshot.rxPackets} pkts · {formatBytes(snapshot.rxBytes)}
            </p>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            <Button size="sm" variant={snapshot.linkUp ? 'outline' : 'default'} className="h-7 text-xs" onClick={() => setLink(!snapshot.linkUp)}>
              {snapshot.linkUp ? 'Drop link' : 'Raise link'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground"
              aria-expanded={showImpairments}
              onClick={() => setShowImpairments((s) => !s)}
            >
              <ChevronDown className={cn('size-3 transition-transform', !showImpairments && '-rotate-90')} />
              Impairments
            </Button>
          </div>
          {showImpairments && (
            <div className="space-y-2 rounded-md border border-border p-2">
              <ImpairmentSlider
                label="Added latency"
                value={snapshot.impairments.delayMs}
                unit="ms"
                max={500}
                step={10}
                onChange={(delayMs) => setImpairments({ delayMs })}
              />
              <ImpairmentSlider
                label="Packet loss"
                value={snapshot.impairments.lossPct}
                unit="%"
                max={20}
                step={1}
                onChange={(lossPct) => setImpairments({ lossPct })}
              />
            </div>
          )}

          <CaptureSection
            count={snapshot.captureCount}
            version={snapshot.captureVersion}
            paused={snapshot.capturePaused}
          />

          <ToolsSection guestIp={snapshot.guestIp} />

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            In the guest shell (where present):{' '}
            <code className="font-mono text-foreground">net iface</code>,{' '}
            <code className="font-mono text-foreground">net ping 192.0.2.2</code>,{' '}
            <code className="font-mono text-foreground">zperf udp upload 192.0.2.2 5001 10 1K 1M</code>.
          </p>
        </div>
      )}
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
        <span className="font-medium">This network is the page.</span> Every frame the guest sends
        lands in JavaScript, which answers as gateway, DHCP, DNS — and as every remote host. No
        packet reaches the real internet.
      </p>
      <p>
        <span className="font-medium text-success">Real:</span> DNS answers (looked up via
        DNS-over-HTTPS) · HTTP the guest sends to any host&apos;s :80/:8080, re-issued as a browser{' '}
        <code className="font-mono">fetch()</code> — CORS decides what is readable,{' '}
        <code className="font-mono">host.internal</code> always works.
      </p>
      <p>
        <span className="font-medium text-warning">Simulated:</span> ping replies — every address
        &quot;answers&quot; because the page does, not the host · SNTP (your browser&apos;s clock) ·
        the echo and zperf peers at 192.0.2.x.
      </p>
      <p>
        <span className="font-medium text-destructive">Impossible:</span> HTTPS or raw TCP/UDP to
        real hosts — browser pages have no sockets. Servers the guest runs are reachable only
        through the tools below.
      </p>
      <p className="text-muted-foreground">
        Roadmap: an opt-in uplink to a local passt gateway, for real network access when a helper
        daemon runs beside the dev server.
      </p>
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

function ImpairmentSlider({
  label,
  value,
  unit,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  unit: string
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {value} {unit}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-[var(--color-primary)]"
      />
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
        <span className="text-xs font-medium">Capture</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{count}</span>
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

function ToolsSection({ guestIp }: { guestIp: string | null }) {
  const [url, setUrl] = useState('http://192.0.2.1:8080/')
  const [httpBusy, setHttpBusy] = useState(false)
  const [httpResult, setHttpResult] = useState<string | null>(null)
  const [httpError, setHttpError] = useState<string | null>(null)

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
      <span className="text-xs font-medium">Talk to the guest</span>

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
