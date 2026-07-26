/**
 * Dock bodies for LED-class parts: HT16K33 matrix, LP5562 RGBW, SCT2024 bar.
 */

import { useEffect, useReducer, useRef } from 'react'
import { RegisterMapButton } from '@/components/RegisterMap'
import type { Ht16k33Chip } from '@/virtio/devices/chips/ht16k33'
import type { Lp5562Chip } from '@/virtio/devices/chips/lp5562'
import type { Sct2024Chip } from '@/virtio/devices/chips/sct2024'
import { cn } from '@/lib/utils'

const UI_MS = 50

function useChipVersion(subscribe: (fn: () => void) => () => void, version: () => number) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubscribe = subscribe(() => {
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
  }, [subscribe, version])
}

function useChip(chip: { subscribe: (fn: () => void) => () => void; version: () => number }) {
  useChipVersion(chip.subscribe, chip.version)
}

function blinkPeriodMs(blink: ReturnType<Ht16k33Chip['getBlink']>): number | null {
  if (blink === '2hz') return 500
  if (blink === '1hz') return 1000
  if (blink === '0.5hz') return 2000
  return null
}

function MatrixCanvas({ chip }: { chip: Ht16k33Chip }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useChip(chip)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const cell = 10
    const gap = 2
    const pad = 6
    const width = pad * 2 + chip.cols * cell + (chip.cols - 1) * gap
    const height = pad * 2 + chip.rows * cell + (chip.rows - 1) * gap
    canvas.width = width
    canvas.height = height

    let frame = 0
    let painted = -1
    let blinkOn = true
    let blinkTimer: ReturnType<typeof setInterval> | undefined

    const paint = () => {
      frame = 0
      const version = chip.version()
      const stamp = version * 2 + (blinkOn ? 1 : 0)
      if (stamp === painted) return
      painted = stamp

      const on = chip.isDisplayOn() && chip.isOscillatorOn()
      const level = chip.getBrightness()
      const intensity = on ? (level + 1) / 16 : 0
      const show = on && (blinkPeriodMs(chip.getBlink()) === null || blinkOn)

      ctx.fillStyle = '#0c0e12'
      ctx.fillRect(0, 0, width, height)

      for (let row = 0; row < chip.rows; row++) {
        for (let col = 0; col < chip.cols; col++) {
          const x = pad + col * (cell + gap)
          const y = pad + row * (cell + gap)
          const lit = show && (chip.memory[row]! & (1 << col)) !== 0
          if (lit) {
            const g = Math.round(180 + 75 * intensity)
            ctx.fillStyle = `rgb(${g},${g},${Math.round(40 + 40 * intensity)})`
          } else {
            ctx.fillStyle = '#1a1d24'
          }
          ctx.fillRect(x, y, cell, cell)
        }
      }
    }

    const syncBlink = () => {
      if (blinkTimer !== undefined) {
        clearInterval(blinkTimer)
        blinkTimer = undefined
      }
      const period = blinkPeriodMs(chip.getBlink())
      blinkOn = true
      if (period != null) {
        blinkTimer = setInterval(() => {
          blinkOn = !blinkOn
          paint()
        }, period / 2)
      }
      paint()
    }

    const unsubscribe = chip.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0
        syncBlink()
      })
    })
    syncBlink()
    return () => {
      unsubscribe()
      if (blinkTimer !== undefined) clearInterval(blinkTimer)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [chip])

  return <canvas ref={canvasRef} className="mx-auto block rounded-sm" />
}

/** HT16K33 16×8 matrix body. */
export function LedMatrixBody({ chip }: { chip: Ht16k33Chip }) {
  useChip(chip)
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {chip.cols}×{chip.rows}
          {chip.isDisplayOn() ? '' : ' · off'}
          {chip.getBlink() !== 'off' ? ` · blink ${chip.getBlink()}` : ''}
        </div>
        <RegisterMapButton chip={chip} />
      </div>
      <MatrixCanvas chip={chip} />
    </div>
  )
}

/**
 * LP5562 RGBW body — one big mixed orb plus four channel meters.
 * Polls while engines may be blinking so the orb keeps flashing.
 */
export function RgbLedBody({ chip }: { chip: Lp5562Chip }) {
  useChip(chip)
  const [, force] = useReducer((n: number) => n + 1, 0)

  // Engines blink without further I²C traffic — keep the orb alive at ~20 Hz.
  useEffect(() => {
    const id = setInterval(() => force(), 50)
    return () => clearInterval(id)
  }, [chip])

  const rgb = chip.getRgb()
  const enabled = chip.isChipEnabled()
  const mix = mixRgbw(rgb)
  const labels = ['B', 'G', 'R', 'W'] as const
  const values = [rgb.b, rgb.g, rgb.r, rgb.w]

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'size-14 shrink-0 rounded-full border border-border transition-colors duration-75',
              enabled ? 'shadow-[0_0_18px_rgba(255,255,255,0.18)]' : 'opacity-40',
            )}
            style={{
              background: enabled
                ? `radial-gradient(circle at 35% 30%, ${mix.glow}, ${mix.fill} 55%, #0c0e12 100%)`
                : '#1a1d24',
            }}
            aria-label={`RGBW ${rgb.r},${rgb.g},${rgb.b},${rgb.w}`}
          />
          <div>
            <div className="font-mono text-sm tabular-nums tracking-tight">
              R{rgb.r} G{rgb.g} B{rgb.b}
              {rgb.w > 0 ? ` W${rgb.w}` : ''}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              LP5562{enabled ? '' : ' · chip off'}
            </div>
          </div>
        </div>
        <RegisterMapButton chip={chip} />
      </div>

      <div className="grid grid-cols-4 gap-2">
        {labels.map((label, i) => (
          <ChannelMeter key={label} label={label} value={values[i]!} accent={channelColor(label)} />
        ))}
      </div>
    </div>
  )
}

function channelColor(ch: 'B' | 'G' | 'R' | 'W'): string {
  if (ch === 'R') return '#f87171'
  if (ch === 'G') return '#4ade80'
  if (ch === 'B') return '#60a5fa'
  return '#e7e5e4'
}

function mixRgbw(rgb: { r: number; g: number; b: number; w: number }): {
  fill: string
  glow: string
} {
  const w = rgb.w / 255
  const r = Math.min(255, Math.round(rgb.r + rgb.w * 0.85))
  const g = Math.min(255, Math.round(rgb.g + rgb.w * 0.85))
  const b = Math.min(255, Math.round(rgb.b + rgb.w * 0.85))
  const a = Math.max(rgb.r, rgb.g, rgb.b, rgb.w) / 255
  return {
    fill: `rgba(${r},${g},${b},${0.35 + 0.55 * a})`,
    glow: `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)},${0.55 + 0.35 * w})`,
  }
}

function ChannelMeter({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent: string
}) {
  const pct = Math.round((value / 255) * 100)
  return (
    <div className="rounded-sm bg-muted/40 px-1.5 py-1.5">
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-muted">
        <div
          className="h-full rounded-sm transition-[width] duration-75"
          style={{ width: `${pct}%`, background: accent }}
        />
      </div>
    </div>
  )
}

/** SCT2024 16-channel SPI LED bar — one lit cell per latched output bit. */
export function LedBarBody({ chip }: { chip: Sct2024Chip }) {
  useChip(chip)
  const bitmap = chip.getBitmap()
  const onCount = Array.from({ length: chip.ledCount }, (_, i) => (bitmap >> i) & 1).reduce(
    (a, b) => a + b,
    0,
  )

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          SCT2024 · {onCount}/{chip.ledCount} on
          {(chip.peek(0x02) & 0x01) === 0 ? ' · OE blanked' : ''}
        </div>
        <RegisterMapButton chip={chip} />
      </div>
      <div className="grid grid-cols-8 gap-1.5">
        {Array.from({ length: chip.ledCount }, (_, i) => {
          const on = chip.isLedOn(i)
          return (
            <div
              key={i}
              title={`LED ${i}${on ? ' on' : ' off'}`}
              className={cn(
                'aspect-square rounded-sm border border-border transition-colors duration-75',
                on
                  ? 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.45)]'
                  : 'bg-[#1a1d24]',
              )}
            />
          )
        })}
      </div>
    </div>
  )
}
