import { DisplayPanel } from '@/components/DisplayPanel'
import { GnssPanel } from '@/components/GnssPanel'
import { GpioPanel } from '@/components/GpioPanel'
import { SensorPanel } from '@/components/SensorPanel'

/** Shared floating stack for optional devices exposed by the running emulator. */
export function PeripheralPanels() {
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-20 flex max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] flex-col items-end gap-3">
      <DisplayPanel />
      <GnssPanel />
      <SensorPanel />
      <GpioPanel />
    </div>
  )
}
