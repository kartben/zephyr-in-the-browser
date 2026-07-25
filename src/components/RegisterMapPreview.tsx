/**
 * Screenshot / demo surface for the SVD-style register map.
 *
 * Open with `?preview=regmap`. Renders real sensor cards (same SensorBody +
 * RegisterMap dialog as the dock) against the app chrome, so mockups are
 * grounded in the live UI rather than a separate design tool.
 */

import { useEffect, useState } from 'react'
import { Thermometer, Activity, Cpu } from 'lucide-react'
import { SensorBody } from '@/components/SensorCard'
import { createTmp112 } from '@/virtio/devices/sensors/tmp112'
import { createAdxl345 } from '@/virtio/devices/sensors/adxl345'
import { createLsm6dso } from '@/virtio/devices/sensors/lsm6dso'
import type { SensorChip } from '@/virtio/devices/sensors/model'

const tmp112 = createTmp112({ celsius: 21.5 })
const adxl = createAdxl345()
const lsm = createLsm6dso()
// Seed LSM6DSO the way the sample's sensor_attr_set would: 12.5 Hz, ±2 g / ±250.
lsm.setAttr('accel_odr', 1)
lsm.setAttr('gyro_odr', 1)

const CARDS: Array<{
  chip: SensorChip
  icon: typeof Thermometer
  autoOpen?: boolean
  expand?: string[]
}> = [
  {
    chip: tmp112,
    icon: Thermometer,
    autoOpen: true,
    expand: ['Configuration', 'Temperature'],
  },
  { chip: adxl, icon: Activity },
  { chip: lsm, icon: Cpu },
]

function SensorPreviewCard({
  chip,
  icon: Icon,
  autoOpen,
  expand,
}: {
  chip: SensorChip
  icon: typeof Thermometer
  autoOpen?: boolean
  expand?: string[]
}) {
  const [openOnce] = useState(Boolean(autoOpen))

  useEffect(() => {
    if (!openOnce) return
    const id = window.setTimeout(() => {
      const link = [...document.querySelectorAll('button')].find((b) =>
        /^Registers\b/i.test((b.textContent || '').trim()),
      )
      link?.click()
      window.setTimeout(() => {
        for (const name of expand ?? []) {
          const btn = [...document.querySelectorAll('button')].find((b) =>
            (b.textContent || '').includes(name),
          )
          if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click()
        }
      }, 200)
    }, 250)
    return () => window.clearTimeout(id)
  }, [openOnce, expand])

  const hex = chip.address.toString(16).padStart(2, '0')

  return (
    <section className="w-[22rem] overflow-hidden rounded-lg border border-border bg-card shadow-xl">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className="size-3.5 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold tracking-tight">{chip.name}</div>
          <div className="font-mono text-[10px] text-muted-foreground">
            virtio_i2c0 · 0x{hex}
          </div>
        </div>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
          sensor
        </span>
      </header>
      <SensorBody chip={chip} />
    </section>
  )
}

export function RegisterMapPreview() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(ellipse at 20% 0%, oklch(0.35 0.08 292 / 0.35), transparent 55%), radial-gradient(ellipse at 80% 100%, oklch(0.3 0.04 250 / 0.25), transparent 50%)',
        }}
      />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Zephyr in the Browser
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">I²C register map</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            SVD-inspired JSON maps drive a live inspector on every sensor card — collapsed
            until you open <span className="text-foreground">Registers</span>.
          </p>
        </header>

        <div className="flex flex-wrap items-start gap-5">
          {CARDS.map((card) => (
            <SensorPreviewCard key={card.chip.address} {...card} />
          ))}
        </div>
      </div>
    </div>
  )
}
