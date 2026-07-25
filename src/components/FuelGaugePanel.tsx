/**
 * Dock body for any {@link FuelGaugeChip}.
 *
 * Big SoC readout, voltage bar, charge/discharge rate, and sliders so the page
 * can drive the cell the guest is reading. Provider-agnostic — do not import
 * MAX17048 here. Registers opens the shared map dialog.
 */

import { useEffect, useReducer } from 'react'
import { Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium } from 'lucide-react'
import { RegisterMapButton } from '@/components/RegisterMap'
import {
  estimateRuntimeMins,
  formatCrate,
  formatRuntimeMins,
  formatSocPct,
  formatVoltageMv,
  voltageFraction,
  type FuelGaugeChip,
} from '@/virtio/devices/fuel-gauge/model'
import { cn } from '@/lib/utils'

const UI_MS = 50

function useChip(chip: FuelGaugeChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      const now = performance.now()
      const wait = UI_MS - (now - last)
      if (wait <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        refresh()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, wait)
    })
    refresh()
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
}

function BatteryGlyph({ soc, charging }: { soc: number; charging: boolean }) {
  if (charging) return <BatteryCharging className="size-5 text-emerald-400" aria-hidden />
  if (soc >= 90) return <BatteryFull className="size-5 text-emerald-400" aria-hidden />
  if (soc >= 40) return <BatteryMedium className="size-5 text-amber-300" aria-hidden />
  if (soc >= 15) return <BatteryLow className="size-5 text-orange-400" aria-hidden />
  return <Battery className="size-5 text-rose-400" aria-hidden />
}

export function FuelGaugeBody({ chip }: { chip: FuelGaugeChip }) {
  useChip(chip)
  const reading = chip.getReading()
  const runtime = estimateRuntimeMins(reading)
  const vFrac = voltageFraction(reading.voltageUv, chip.decl)
  const soc = Math.round(reading.socPct)

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <BatteryGlyph soc={soc} charging={reading.charging} />
          <div>
            <div className="font-mono text-3xl font-semibold tabular-nums leading-none tracking-tight">
              {formatSocPct(reading.socPct)}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {chip.decl.name}
              {chip.decl.designCapacityMah
                ? ` · ${chip.decl.designCapacityMah} mAh design`
                : null}
            </div>
          </div>
        </div>
        <RegisterMapButton chip={chip} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-muted-foreground">Cell</span>
          <span className="font-mono tabular-nums">{formatVoltageMv(reading.voltageUv)}</span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-sm bg-muted"
          role="meter"
          aria-valuemin={chip.decl.vEmptyMv}
          aria-valuemax={chip.decl.vFullMv}
          aria-valuenow={Math.round(reading.voltageUv / 1000)}
          aria-label="Cell voltage"
        >
          <div
            className={cn(
              'h-full rounded-sm transition-[width] duration-150',
              reading.charging ? 'bg-emerald-400' : 'bg-sky-400',
            )}
            style={{ width: `${Math.round(vFrac * 100)}%` }}
          />
        </div>
        <div className="flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
          <span>{chip.decl.vEmptyMv} mV</span>
          <span>{chip.decl.vFullMv} mV</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <Metric
          label="Rate"
          value={formatCrate(reading.cratePctPerHour)}
          tone={reading.charging ? 'charge' : reading.cratePctPerHour < 0 ? 'discharge' : 'idle'}
        />
        <Metric label="To empty" value={formatRuntimeMins(runtime.toEmpty)} />
        <Metric label="To full" value={formatRuntimeMins(runtime.toFull)} />
      </div>

      <label className="flex flex-col gap-1 text-[11px]">
        <span className="flex justify-between text-muted-foreground">
          <span>State of charge</span>
          <span className="font-mono tabular-nums">{soc}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={soc}
          onChange={(e) => chip.setSocPct(Number(e.target.value))}
          className="w-full accent-sky-400"
        />
      </label>

      <label className="flex flex-col gap-1 text-[11px]">
        <span className="flex justify-between text-muted-foreground">
          <span>Voltage</span>
          <span className="font-mono tabular-nums">
            {Math.round(reading.voltageUv / 1000)} mV
          </span>
        </span>
        <input
          type="range"
          min={chip.decl.vEmptyMv}
          max={chip.decl.vFullMv}
          step={10}
          value={Math.round(reading.voltageUv / 1000)}
          onChange={(e) => chip.setVoltageMv(Number(e.target.value))}
          className="w-full accent-sky-400"
        />
      </label>

      <label className="flex flex-col gap-1 text-[11px]">
        <span className="flex justify-between text-muted-foreground">
          <span>Charge rate</span>
          <span className="font-mono tabular-nums">{formatCrate(reading.cratePctPerHour)}</span>
        </span>
        <input
          type="range"
          min={-40}
          max={40}
          step={0.5}
          value={Number(reading.cratePctPerHour.toFixed(1))}
          onChange={(e) => chip.setCratePctPerHour(Number(e.target.value))}
          className="w-full accent-sky-400"
        />
      </label>
    </div>
  )
}

function Metric({
  label,
  value,
  tone = 'idle',
}: {
  label: string
  value: string
  tone?: 'charge' | 'discharge' | 'idle'
}) {
  return (
    <div className="rounded-sm bg-muted/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 font-mono text-[12px] tabular-nums',
          tone === 'charge' && 'text-emerald-400',
          tone === 'discharge' && 'text-amber-300',
        )}
      >
        {value}
      </div>
    </div>
  )
}
