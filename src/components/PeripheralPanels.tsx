import { AudioPanel } from '@/components/AudioPanel'
import { DisplayPanel } from '@/components/DisplayPanel'
import { GnssPanel } from '@/components/GnssPanel'
import { GpioPanel } from '@/components/GpioPanel'
import { PerformancePanel } from '@/components/PerformancePanel'
import { SensorPanel } from '@/components/SensorPanel'
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

/** Shared floating stack for optional devices exposed by the running emulator. */
export function PeripheralPanels({ primaryPanels, expandAll = false }: PeripheralPanelsProps) {
  const expanded = (kind: PanelKind) => expandAll || primaryPanels.has(kind)
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-20 flex max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col items-end gap-3">
      <DisplayPanel defaultExpanded={expanded('display')} />
      <GnssPanel defaultExpanded={expanded('gnss')} />
      <SensorPanel defaultExpanded={expanded('sensor')} />
      <GpioPanel defaultExpanded={expanded('gpio')} />
      <AudioPanel defaultExpanded={expanded('audio')} />
      {/* Guest throughput is about no single sample; leave it collapsed. */}
      <PerformancePanel defaultExpanded={expanded('perf')} />
    </div>
  )
}
