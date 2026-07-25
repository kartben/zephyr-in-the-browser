/**
 * One switch from a DeviceNode to the body it hosts, used verbatim by the
 * dock's rows and by the floating windows — the guarantee that popping a
 * device out shows exactly what its row showed. Plus the small live badge a
 * row wears while collapsed, and the icon both presentations share.
 */

import { useCallback, useSyncExternalStore } from 'react'
import {
  Cable,
  CircuitBoard,
  Gauge,
  MapPin,
  MemoryStick,
  Mic,
  Monitor,
  MonitorDot,
  Network,
  Pointer,
  SquareChevronRight,
  Volume2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { MicBody, SpeakerBody } from '@/components/AudioPanel'
import { GnssBody } from '@/components/GnssPanel'
import { GpioBody } from '@/components/GpioPanel'
import { I2cBody } from '@/components/I2cPanel'
import { MemoryBody } from '@/components/MemoryCard'
import { NetworkBody } from '@/components/NetworkPanel'
import { OledBody } from '@/components/OledPanel'
import { SensorBody } from '@/components/SensorCard'
import { cn } from '@/lib/utils'
import type { DeviceClass, DeviceNode } from '@/deviceTopology'
import * as hostAudio from '@/hostAudio'
import * as hostGnss from '@/hostGnss'
import * as hostGpio from '@/hostGpio'
import * as hostMic from '@/hostMic'
import * as hostNet from '@/hostNet'
import { setWindowed } from '@/lib/dockStore'
import { i2cModel } from '@/virtio'
import type { MemoryChip } from '@/virtio/devices/memory/model'
import type { SensorChip } from '@/virtio/devices/sensors/model'
import type { Ssd1306Chip } from '@/virtio/devices/chips/ssd1306'

export function DeviceBody({
  node,
  variant = 'dock',
}: {
  node: DeviceNode
  /** Only memory differs today: the dock gets a preview, the window the editor. */
  variant?: 'dock' | 'window'
}) {
  switch (node.body) {
    case 'sensor':
      return <SensorBody chip={node.chip as SensorChip} />
    case 'memory':
      return (
        <MemoryBody
          chip={node.chip as MemoryChip}
          compact={variant === 'dock'}
          onOpenWindow={variant === 'dock' ? () => setWindowed(node.key, true) : undefined}
        />
      )
    case 'oled':
      return <OledBody />
    case 'i2c':
      return <I2cBody busLabel={node.busLabel} />
    case 'gpio':
      return <GpioBody />
    case 'gnss':
      return <GnssBody />
    case 'speaker':
      return <SpeakerBody />
    case 'mic':
      return <MicBody />
    case 'net':
      return <NetworkBody sectionsKey={node.key} />
    default:
      return null
  }
}

export function deviceIcon(node: DeviceNode): LucideIcon {
  switch (node.body) {
    case 'sensor':
      return Gauge
    case 'memory':
      return MemoryStick
    case 'oled':
      return MonitorDot
    case 'i2c':
      return Cable
    case 'gpio':
      return CircuitBoard
    case 'gnss':
      return MapPin
    case 'speaker':
      return Volume2
    case 'mic':
      return Mic
    case 'net':
      return Network
  }
  switch (node.deviceClass) {
    case 'display':
      return Monitor
    case 'i2c-bus':
      return Cable
    case 'serial':
      return SquareChevronRight
    case 'gpio':
      return CircuitBoard
    case 'sensor':
      return Gauge
    case 'memory':
      return MemoryStick
    default:
      return node.key === 'input' ? Pointer : Cable
  }
}

/**
 * The at-a-glance value a row shows on its right edge: a temperature, a link
 * dot with the IP, a chip count. Collapsed must not mean blind.
 */
export function DeviceBadge({ node }: { node: DeviceNode }) {
  switch (node.body) {
    case 'sensor':
      return <SensorBadge chip={node.chip as SensorChip} />
    case 'memory': {
      const chip = node.chip as MemoryChip
      return <Mono>{chip.decl.size} B</Mono>
    }
    case 'oled': {
      const chip = node.chip as Ssd1306Chip
      return (
        <Mono>
          {chip.width}×{chip.height}
        </Mono>
      )
    }
    case 'i2c':
      return <BusBadge />
    case 'gnss':
      return <GnssBadge />
    case 'net':
      return <NetBadge />
    case 'gpio':
      return <GpioBadge />
    case 'speaker':
      return <SpeakerBadge />
    case 'mic':
      return <MicBadge />
    default:
      return null
  }
}

/**
 * A collapsed ▤ group keeps a pulse: the summary badge its header wears.
 * Same live sub-badges as the rows, chosen per class.
 */
export function GroupBadge({
  deviceClass,
  nodes,
}: {
  deviceClass: DeviceClass
  nodes: DeviceNode[]
}) {
  if (deviceClass === 'sensor') {
    const chips = nodes.filter((n) => n.presence === 'interactive' && n.body === 'sensor')
    if (chips.length === 0) return null
    return (
      <span className="flex items-center gap-2">
        {chips.slice(0, 2).map((n) => (
          <SensorBadge key={n.key} chip={n.chip as SensorChip} />
        ))}
      </span>
    )
  }
  if (deviceClass === 'net' && nodes.some((n) => n.body === 'net')) return <NetBadge />
  if (deviceClass === 'gpio' && nodes.some((n) => n.body === 'gpio')) return <GpioBadge />
  if (deviceClass === 'i2c-bus' && nodes.some((n) => n.body === 'i2c')) return <BusBadge />
  if (deviceClass === 'gnss' && nodes.some((n) => n.body === 'gnss')) return <GnssBadge />
  return null
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[10px] tabular-nums text-muted-foreground', className)}>
      {children}
    </span>
  )
}

function SensorBadge({ chip }: { chip: SensorChip }) {
  useSyncExternalStore(
    chip.subscribe,
    useCallback(() => chipRevision(chip), [chip]),
    () => '',
  )
  const first = chip.decl.channels[0]
  if (!first) return null
  const many = chip.decl.channels.length > 1
  return (
    <Mono>
      {many
        ? chip.decl.channels.map((c) => chip.getChannel(c.key).toFixed(1)).join(' · ')
        : `${chip.getChannel(first.key).toFixed(2)} ${first.unit}`}
    </Mono>
  )
}

/** A cheap change token so useSyncExternalStore sees channel movement. */
function chipRevision(chip: SensorChip): string {
  return chip.decl.channels.map((c) => chip.getChannel(c.key).toFixed(3)).join(',')
}

function BusBadge() {
  const chips = useSyncExternalStore(
    i2cModel.subscribe,
    i2cModel.chips,
    useCallback(() => [], []),
  )
  return (
    <Mono>
      {chips.length} {chips.length === 1 ? 'chip' : 'chips'}
    </Mono>
  )
}

function GnssBadge() {
  const fix = useSyncExternalStore(hostGnss.subscribe, hostGnss.getSnapshot, hostGnss.getSnapshot)
  return (
    <Mono>
      {fix.latitude.toFixed(4)}, {fix.longitude.toFixed(4)}
    </Mono>
  )
}

function NetBadge() {
  const snapshot = useSyncExternalStore(hostNet.subscribe, hostNet.getSnapshot, hostNet.getSnapshot)
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn('size-2 rounded-full', snapshot.linkUp ? 'bg-success' : 'bg-destructive')}
        role="status"
        aria-label={snapshot.linkUp ? 'Link up' : 'Link down'}
      />
      {snapshot.guestIp && <Mono>{snapshot.guestIp}</Mono>}
    </span>
  )
}

function GpioBadge() {
  const leds = useSyncExternalStore(hostGpio.subscribe, hostGpio.getLeds, useCallback(() => [], []))
  // A change token so output edges re-render the dots.
  useSyncExternalStore(
    hostGpio.subscribe,
    useCallback(
      () => hostGpio.getLeds().map((pin) => (hostGpio.isOutputHigh(pin.id) ? '1' : '0')).join(''),
      [],
    ),
    () => '',
  )
  if (leds.length === 0) return null
  return (
    <span className="flex items-center gap-1" aria-label="LED states">
      {leds.slice(0, 4).map((pin) => (
        <span
          key={pin.id}
          title={pin.label}
          className={cn(
            'size-[7px] rounded-full',
            hostGpio.isOutputHigh(pin.id)
              ? 'bg-primary shadow-[0_0_5px_var(--color-primary)]'
              : 'bg-border',
          )}
        />
      ))}
    </span>
  )
}

function SpeakerBadge() {
  const audio = useSyncExternalStore(hostAudio.subscribe, hostAudio.getSnapshot, hostAudio.getSnapshot)
  return <Mono>{audio.enabled ? 'on' : 'muted'}</Mono>
}

function MicBadge() {
  const mic = useSyncExternalStore(hostMic.subscribe, hostMic.getSnapshot, hostMic.getSnapshot)
  return <Mono>{mic.enabled ? 'on' : 'off'}</Mono>
}
