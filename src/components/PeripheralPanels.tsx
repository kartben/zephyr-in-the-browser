import { useCallback, useSyncExternalStore } from 'react'
import { AudioPanel } from '@/components/AudioPanel'
import { DisplayPanel } from '@/components/DisplayPanel'
import { GnssPanel } from '@/components/GnssPanel'
import { GpioPanel } from '@/components/GpioPanel'
import { I2cPanel } from '@/components/I2cPanel'
import { OledPanel } from '@/components/OledPanel'
import { NetworkPanel } from '@/components/NetworkPanel'
import { PerformancePanel } from '@/components/PerformancePanel'
import { SensorCard } from '@/components/SensorCard'
import { i2cModel, isBound, subscribeBinds } from '@/virtio'
import { isSensorChip } from '@/virtio/devices/sensors/model'
import type { PanelKind } from '@/boards'

interface PeripheralPanelsProps {
  /**
   * Panels the running sample is about — expanded on boot. Everything else
   * starts collapsed so incidental bridges stay out of the way.
   */
  primaryPanels: Set<PanelKind>
  /**
   * A user-supplied ELF whose peripherals we cannot know: expand everything the
   * emulator exposes, keeping the panels discoverable.
   */
  expandAll?: boolean
}

/**
 * The floating overlay for the running emulator's optional devices, split into
 * two edges: **buses** on the left are debug + attach/detach surfaces, and
 * **devices** on the right are the things on them — sensors, a screen, GNSS,
 * GPIO — each with its own controls. A panel stays hidden until the emulator
 * actually exposes it, and opens collapsed unless the sample is about it.
 */
export function PeripheralPanels({ primaryPanels, expandAll = false }: PeripheralPanelsProps) {
  const expanded = (kind: PanelKind) => expandAll || primaryPanels.has(kind)

  const i2cAvailable = useSyncExternalStore(
    subscribeBinds,
    useCallback(() => isBound('i2c'), []),
    () => false,
  )
  const chips = useSyncExternalStore(
    i2cModel.subscribe,
    i2cModel.chips,
    useCallback(() => [], []),
  )
  const sensors = i2cAvailable ? chips.filter(isSensorChip) : []

  return (
    <>
      {/* Buses — the debug + attach/detach side. */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col items-start gap-3">
        <I2cPanel defaultExpanded={expanded('i2c')} />
      </div>

      {/* Devices — the things on the buses, plus the standalone bridges. */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-20 flex max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col items-end gap-3">
        <DisplayPanel defaultExpanded={expanded('display')} />
        {sensors.map((chip) => (
          <SensorCard key={chip.address} chip={chip} defaultExpanded={expanded('sensor')} />
        ))}
        <GnssPanel defaultExpanded={expanded('gnss')} />
        <GpioPanel defaultExpanded={expanded('gpio')} />
        <OledPanel defaultExpanded={expanded('oled')} />
        <AudioPanel defaultExpanded={expanded('audio')} />
        <NetworkPanel defaultExpanded={expanded('net')} />
        {/* Guest throughput is about no single sample; leave it collapsed. */}
        <PerformancePanel defaultExpanded={expanded('perf')} />
      </div>
    </>
  )
}
