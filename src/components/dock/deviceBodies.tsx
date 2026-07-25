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
  Clock,
  Gauge,
  MapPin,
  MemoryStick,
  Mic,
  Monitor,
  MonitorDot,
  Network,
  Pointer,
  SquareChevronRight,
  Activity,
  Grid3x3,
  Vibrate,
  Volume2,
  Waves,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { MicBody, SpeakerBody } from '@/components/AudioPanel'
import { AuxdisplayBody } from '@/components/AuxdisplayPanel'
import { BuzzerBody } from '@/components/BuzzerPanel'
import { GnssBody } from '@/components/GnssPanel'
import { GpioBody } from '@/components/GpioPanel'
import { I2cBody } from '@/components/I2cPanel'
import { LedMatrixBody } from '@/components/LedPanel'
import { MemoryBody } from '@/components/MemoryCard'
import { NetworkBody } from '@/components/NetworkPanel'
import { OledBody } from '@/components/OledPanel'
import { DacBody } from '@/components/DacPanel'
import { PwmBody } from '@/components/PwmPanel'
import { RtcBadge, RtcBody } from '@/components/RtcCard'
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
import type { Ht16k33Chip } from '@/virtio/devices/chips/ht16k33'
import type { Jhd1313LcdChip } from '@/virtio/devices/chips/jhd1313'
import type { MemoryChip } from '@/virtio/devices/memory/model'
import {
  formatDacVolts,
  type DacChip,
} from '@/virtio/devices/dac/model'
import {
  formatPwmDuty,
  type PwmChip,
} from '@/virtio/devices/pwm/model'
import type { RtcChip } from '@/virtio/devices/rtc/model'
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
    case 'auxdisplay':
      return <AuxdisplayBody chip={node.chip as Jhd1313LcdChip} />
    case 'led':
      return <LedMatrixBody chip={node.chip as Ht16k33Chip} />
    case 'pwm':
      return <PwmBody chip={node.chip as PwmChip} />
    case 'dac':
      return <DacBody chip={node.chip as DacChip} />
    case 'rtc':
      return <RtcBody chip={node.chip as RtcChip} />
    case 'i2c':
      return <I2cBody busLabel={node.busLabel} />
    case 'gpio':
      return <GpioBody />
    case 'buzzer':
      return <BuzzerBody />
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
    case 'auxdisplay':
      return Monitor
    case 'led':
      return Grid3x3
    case 'pwm':
      return Activity
    case 'dac':
      return Waves
    case 'rtc':
      return Clock
    case 'i2c':
      return Cable
    case 'gpio':
      return CircuitBoard
    case 'buzzer':
      return Vibrate
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
    case 'auxdisplay':
      return Monitor
    case 'led':
      return Grid3x3
    case 'pwm':
      return Activity
    case 'dac':
      return Waves
    case 'i2c-bus':
      return Cable
    case 'serial':
      return SquareChevronRight
    case 'gpio':
      return CircuitBoard
    case 'buzzer':
      return Vibrate
    case 'sensor':
      return Gauge
    case 'memory':
      return MemoryStick
    case 'rtc':
      return Clock
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
    case 'auxdisplay': {
      const chip = node.chip as Jhd1313LcdChip
      return (
        <Mono>
          {chip.columns}×{chip.rows}
        </Mono>
      )
    }
    case 'led': {
      const chip = node.chip as Ht16k33Chip
      return (
        <Mono>
          {chip.cols}×{chip.rows}
        </Mono>
      )
    }
    case 'pwm': {
      const chip = node.chip as PwmChip
      const ch = chip.getChannel(0)
      return (
        <Mono>
          CH0 · {formatPwmDuty(ch.duty)}
        </Mono>
      )
    }
    case 'dac': {
      const chip = node.chip as DacChip
      const ch = chip.getChannel(0)
      return <Mono>{formatDacVolts(ch.volts)}</Mono>
    }
    case 'rtc':
      return <RtcBadge chip={node.chip as RtcChip} />
    case 'i2c':
      return <BusBadge />
    case 'gnss':
      return <GnssBadge />
    case 'net':
      return <NetBadge />
    case 'gpio':
      return <GpioBadge />
    case 'buzzer':
      return <BuzzerBadge />
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
  if (deviceClass === 'rtc') {
    const chip = nodes.find((n) => n.presence === 'interactive' && n.body === 'rtc')?.chip
    if (chip) return <RtcBadge chip={chip as RtcChip} />
  }
  if (deviceClass === 'auxdisplay') {
    const chip = nodes.find((n) => n.presence === 'interactive' && n.body === 'auxdisplay')
      ?.chip as Jhd1313LcdChip | undefined
    if (chip) {
      return (
        <Mono>
          {chip.columns}×{chip.rows}
        </Mono>
      )
    }
  }
  if (deviceClass === 'led') {
    const chip = nodes.find((n) => n.presence === 'interactive' && n.body === 'led')?.chip as
      | Ht16k33Chip
      | undefined
    if (chip) {
      return (
        <Mono>
          {chip.cols}×{chip.rows}
        </Mono>
      )
    }
  }
  if (deviceClass === 'pwm') {
    const chip = nodes.find((n) => n.presence === 'interactive' && n.body === 'pwm')?.chip as
      | PwmChip
      | undefined
    if (chip) {
      const ch = chip.getChannel(0)
      return (
        <Mono>
          {chip.decl.channelCount} ch · {formatPwmDuty(ch.duty)}
        </Mono>
      )
    }
  }
  if (deviceClass === 'dac') {
    const chip = nodes.find((n) => n.presence === 'interactive' && n.body === 'dac')?.chip as
      | DacChip
      | undefined
    if (chip) {
      const ch = chip.getChannel(0)
      return <Mono>{formatDacVolts(ch.volts)}</Mono>
    }
  }
  if (deviceClass === 'net' && nodes.some((n) => n.body === 'net')) return <NetBadge />
  if (deviceClass === 'gpio' && nodes.some((n) => n.body === 'gpio')) return <GpioBadge />
  if (deviceClass === 'buzzer' && nodes.some((n) => n.body === 'buzzer')) return <BuzzerBadge />
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

/** Accel / gyro / magn axes — the ones that used to dump "0.0 · 0.0 · 9.8 · …". */
function isAxisChannel(zephyr: string): boolean {
  return /^(accel|gyro|magn)_/.test(zephyr)
}

function SensorBadge({ chip }: { chip: SensorChip }) {
  useSyncExternalStore(
    useCallback(
      (onStoreChange) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let last = 0
        const deliver = () => {
          last = performance.now()
          onStoreChange()
        }
        const unsubscribe = chip.subscribe(() => {
          const now = performance.now()
          const wait = 50 - (now - last)
          if (wait <= 0) {
            if (timer !== undefined) {
              clearTimeout(timer)
              timer = undefined
            }
            deliver()
            return
          }
          if (timer !== undefined) return
          timer = setTimeout(() => {
            timer = undefined
            deliver()
          }, wait)
        })
        return () => {
          unsubscribe()
          if (timer !== undefined) clearTimeout(timer)
        }
      },
      [chip],
    ),
    useCallback(() => chipRevision(chip), [chip]),
    () => '',
  )
  // Multi-axis chips (ADXL, LSM6DSO, …) get no row summary — six values do not
  // fit. Everything else shows its first channel (a thermometer, lux, or the
  // lead reading on a pressure/power part).
  const axisCount = chip.decl.channels.filter((c) => isAxisChannel(c.zephyr)).length
  if (axisCount > 1) return null
  const first = chip.decl.channels[0]
  if (!first) return null
  return (
    <Mono>
      {chip.getChannel(first.key).toFixed(2)} {first.unit}
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

function BuzzerBadge() {
  const buzzers = useSyncExternalStore(
    hostGpio.subscribe,
    hostGpio.getBuzzers,
    useCallback(() => [], []),
  )
  useSyncExternalStore(
    hostGpio.subscribe,
    useCallback(
      () =>
        hostGpio
          .getBuzzers()
          .map((pin) => (hostGpio.isBuzzerOn(pin) ? '1' : '0'))
          .join(''),
      [],
    ),
    () => '',
  )
  if (buzzers.length === 0) return null
  const anyOn = buzzers.some((pin) => hostGpio.isBuzzerOn(pin))
  return <Mono className={anyOn ? 'text-amber-400' : undefined}>{anyOn ? 'buzz' : 'idle'}</Mono>
}

function SpeakerBadge() {
  const audio = useSyncExternalStore(hostAudio.subscribe, hostAudio.getSnapshot, hostAudio.getSnapshot)
  return <Mono>{audio.enabled ? 'on' : 'muted'}</Mono>
}

function MicBadge() {
  const mic = useSyncExternalStore(hostMic.subscribe, hostMic.getSnapshot, hostMic.getSnapshot)
  return <Mono>{mic.enabled ? 'on' : 'off'}</Mono>
}
