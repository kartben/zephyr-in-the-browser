/**
 * Dock body for any {@link DacChip}.
 *
 * Paints a Vout-over-time trace from getHistory, a level bar, code/Vref
 * readout, and the shared Registers dialog. Provider-agnostic — do not import
 * MCP4725 here.
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import { RegisterMapButton } from '@/components/RegisterMap'
import {
  dacMaxCode,
  formatDacCode,
  formatDacVolts,
  type DacChip,
} from '@/virtio/devices/dac/model'

const UI_MS = 50

function useChip(chip: DacChip) {
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

function VoutCanvas({
  chip,
  channel,
}: {
  chip: DacChip
  channel: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ch = chip.getChannel(channel)
  const history = chip.getHistory(channel)
  const historyMs = chip.decl.historyMs ?? 5000
  const vref = chip.decl.vrefMv / 1000

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cssW = canvas.clientWidth || 360
    const cssH = 168
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const padL = 36
    const padR = 12
    const padT = 22
    const padB = 24
    const plotW = cssW - padL - padR
    const plotH = cssH - padT - padB

    ctx.clearRect(0, 0, cssW, cssH)
    ctx.fillStyle = '#0c0e12'
    ctx.fillRect(0, 0, cssW, cssH)

    const yAt = (volts: number) => {
      const n = vref > 0 ? Math.max(0, Math.min(1, volts / vref)) : 0
      return padT + plotH - n * plotH
    }
    const now = performance.now()
    const t0 = now - historyMs
    const xAt = (t: number) => padL + ((t - t0) / historyMs) * plotW

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (const frac of [0, 0.5, 1]) {
      const y = yAt(vref * frac)
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + plotW, y)
      ctx.stroke()
    }

    // Trace
    const samples = history.length > 0 ? history : [{ t: now, channel, volts: ch.volts, code: ch.code }]
    ctx.strokeStyle = '#3ecf8e'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let started = false
    // Downsample for draw cost.
    const step = Math.max(1, Math.floor(samples.length / 400))
    for (let i = 0; i < samples.length; i += step) {
      const s = samples[i]!
      const x = xAt(s.t)
      const y = yAt(s.volts)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else {
        ctx.lineTo(x, y)
      }
    }
    // Extend to now at current level.
    ctx.lineTo(xAt(now), yAt(ch.volts))
    ctx.stroke()

    // Current guide
    const yNow = yAt(ch.volts)
    ctx.strokeStyle = 'rgba(62,207,142,0.45)'
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(padL, yNow)
    ctx.lineTo(padL + plotW, yNow)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = 'rgba(62,207,142,0.95)'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'right'
    ctx.fillText(`Vout = ${formatDacVolts(ch.volts)}`, padL + plotW, Math.max(padT + 10, yNow - 4))

    // Axes labels
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.textAlign = 'right'
    ctx.fillText(formatDacVolts(vref), padL - 4, padT + 4)
    ctx.fillText(formatDacVolts(vref / 2), padL - 4, yAt(vref / 2) + 3)
    ctx.fillText('0', padL - 4, padT + plotH)

    ctx.textAlign = 'center'
    const secs = historyMs / 1000
    ctx.fillText('0', padL, cssH - 6)
    ctx.fillText(`${(secs / 2).toFixed(secs >= 4 ? 0 : 1)} s`, padL + plotW / 2, cssH - 6)
    ctx.fillText(`${secs.toFixed(secs >= 4 ? 0 : 1)} s`, padL + plotW, cssH - 6)

    if (history.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.textAlign = 'center'
      ctx.fillText('waiting for dac_write_value', padL + plotW / 2, padT + plotH / 2)
    }
  }, [chip, channel, ch, history, historyMs, vref])

  return (
    <canvas
      ref={canvasRef}
      aria-label={`DAC channel ${channel} output`}
      className="h-[168px] w-full rounded border border-border bg-black"
    />
  )
}

export function DacBody({ chip }: { chip: DacChip }) {
  useChip(chip)
  const [selected, setSelected] = useState(0)
  const sel = Math.min(selected, Math.max(0, chip.decl.channelCount - 1))
  const ch = chip.getChannel(sel)
  const max = dacMaxCode(chip.decl)
  const fill = max > 0 ? Math.max(0, Math.min(1, ch.code / max)) : 0

  const details = (chip.decl.detailKeys ?? [])
    .map((key) => {
      const value = chip.getDetail?.(key)
      if (!value) return null
      if (key === 'mode') return value
      if (key === 'eeprom') return `EEPROM ${value}`
      return `${key} ${value}`
    })
    .filter(Boolean)

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          code {formatDacCode(ch.code, chip.decl.resolutionBits)} · {chip.decl.resolutionBits}-bit
        </span>
        <span className="font-mono tabular-nums">Vref = {formatDacVolts(chip.decl.vrefMv / 1000)}</span>
      </div>
      <VoutCanvas chip={chip} channel={sel} />
      <div className="flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
          <div className="h-full bg-success transition-[width] duration-75" style={{ width: `${fill * 100}%` }} />
        </div>
        <span className="font-mono text-sm tabular-nums text-success">{formatDacVolts(ch.volts)}</span>
      </div>
      {chip.decl.channelCount > 1 ? (
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: chip.decl.channelCount }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSelected(i)}
              className={
                i === sel
                  ? 'rounded border border-primary/70 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px]'
                  : 'rounded border border-transparent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted/40'
              }
            >
              CH{i}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          CH{sel} · {ch.powerDown}
        </span>
        {details.map((d) => (
          <span key={d} className="font-mono tabular-nums">
            {d}
          </span>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <code className="font-mono text-foreground">{chip.decl.name}</code>
        {' — '}
        {chip.decl.resolutionBits}-bit DAC
        {chip.address != null ? ` at 0x${chip.address.toString(16)}` : ''}.
      </p>
      <RegisterMapButton chip={chip} />
    </div>
  )
}
