/**
 * Dock body for any {@link DacChip}.
 *
 * Paints a Vout-over-time trace from getHistory, a level bar, code/Vref
 * readout, and the shared Registers dialog. Provider-agnostic — do not import
 * MCP4725 here.
 *
 * The scope time base is wall clock. Guest icount looked right for the stock
 * ~4 s period but freezes while the guest blocks on virtio-i2c (see
 * `dac/clock.ts`); wall time keeps the trace moving with real samples.
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import { RegisterMapButton } from '@/components/RegisterMap'
import { dacNowMs } from '@/virtio/devices/dac/clock'
import {
  DAC_DEFAULT_WINDOW_MS,
  DAC_WINDOW_MS_OPTIONS,
  dacMaxCode,
  formatDacCode,
  formatDacVolts,
  formatDacWindow,
  type DacChip,
} from '@/virtio/devices/dac/model'

/*
 * The scope and its readout share the page's main thread with the virtio
 * dispatcher.  A DAC produces far more updates than a human can read, and on
 * a phone an eager React update competes with the next I2C completion.  Keep
 * the textual controls comfortably live without asking React to reconcile on
 * every sample.
 */
const UI_MS = 100
/** A scope needs motion, not a 60 Hz redraw of identical data. */
const SCOPE_FRAME_MS = 50

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
  windowMs,
}: {
  chip: DacChip
  channel: number
  windowMs: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let alive = true
    let lastPaintAt = -Infinity

    const paint = () => {
      raf = 0
      if (!alive) return
      lastPaintAt = performance.now()
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cssW = canvas.clientWidth || 360
      const cssH = 168
      const pixelW = Math.round(cssW * dpr)
      const pixelH = Math.round(cssH * dpr)
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW
        canvas.height = pixelH
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const padL = 36
      const padR = 12
      const padT = 22
      const padB = 24
      const plotW = cssW - padL - padR
      const plotH = cssH - padT - padB
      const vref = chip.decl.vrefMv / 1000
      const ch = chip.getChannel(channel)
      const history = chip.getHistory(channel)
      const now = dacNowMs()
      const t0 = now - windowMs

      ctx.clearRect(0, 0, cssW, cssH)
      ctx.fillStyle = '#0c0e12'
      ctx.fillRect(0, 0, cssW, cssH)

      const yAt = (volts: number) => {
        const n = vref > 0 ? Math.max(0, Math.min(1, volts / vref)) : 0
        return padT + plotH - n * plotH
      }
      const xAt = (t: number) => padL + ((t - t0) / windowMs) * plotW

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

      // Trace as a held level (DAC steps), not a diagonal interpolate.
      // Walk the ring in place — no filter() copy of a 30 s / 1 kHz buffer.
      const first = Math.max(0, history.lowerBound(t0) - 1)
      const visible = history.length - first
      ctx.strokeStyle = '#3ecf8e'
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.beginPath()
      let started = false
      let prevY = yAt(ch.volts)
      const step = Math.max(1, Math.floor(visible / 800))
      for (let i = first; i < history.length; i += step) {
        const s = history.at(i)
        const x = xAt(s.t)
        const y = yAt(s.volts)
        if (!started) {
          ctx.moveTo(Math.max(padL, x), y)
          started = true
        } else {
          ctx.lineTo(x, prevY)
          ctx.lineTo(x, y)
        }
        prevY = y
      }
      if (started) {
        ctx.lineTo(xAt(now), prevY)
      } else {
        const y = yAt(ch.volts)
        ctx.moveTo(padL, y)
        ctx.lineTo(xAt(now), y)
      }
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

      // Axes labels — left = oldest edge of the window, right = now.
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.textAlign = 'right'
      ctx.fillText(formatDacVolts(vref), padL - 4, padT + 4)
      ctx.fillText(formatDacVolts(vref / 2), padL - 4, yAt(vref / 2) + 3)
      ctx.fillText('0', padL - 4, padT + plotH)

      ctx.textAlign = 'center'
      const secs = windowMs / 1000
      ctx.fillText(`−${formatDacWindow(windowMs)}`, padL, cssH - 6)
      ctx.fillText(`−${(secs / 2).toFixed(secs >= 4 ? 0 : 1)} s`, padL + plotW / 2, cssH - 6)
      ctx.fillText('now', padL + plotW, cssH - 6)

      if (history.length === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.textAlign = 'center'
        ctx.fillText('waiting for dac_write_value', padL + plotW / 2, padT + plotH / 2)
      }

    }

    /*
     * `subscribe` can fire once per I2C transfer.  Coalesce those writes into
     * a single browser frame and cap it at 20 fps: that is fluid for a scope,
     * but leaves the main thread free to dispatch the next bridge wake.  In
     * particular, do not run a perpetual rAF loop while the DAC is idle.
     */
    const requestPaint = () => {
      if (!alive || raf || timer !== undefined) return
      const delay = Math.max(0, SCOPE_FRAME_MS - (performance.now() - lastPaintAt))
      const queueFrame = () => {
        timer = undefined
        if (alive) raf = requestAnimationFrame(paint)
      }
      if (delay > 0) {
        timer = setTimeout(queueFrame, delay)
      } else {
        queueFrame()
      }
    }

    const unsubscribe = chip.subscribe(requestPaint)
    requestPaint()
    return () => {
      alive = false
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      cancelAnimationFrame(raf)
    }
  }, [chip, channel, windowMs])

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
  const [windowMs, setWindowMs] = useState(DAC_DEFAULT_WINDOW_MS)
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
        <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground/80">Win</span>
            <select
              aria-label="Scope window"
              className="h-5 max-w-[4.5rem] rounded border border-border bg-background px-1 text-[10px] text-foreground"
              value={windowMs}
              onChange={(e) => setWindowMs(Number(e.target.value))}
            >
              {DAC_WINDOW_MS_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {formatDacWindow(ms)}
                </option>
              ))}
            </select>
          </label>
          <span>Vref = {formatDacVolts(chip.decl.vrefMv / 1000)}</span>
        </div>
      </div>
      <VoutCanvas chip={chip} channel={sel} windowMs={windowMs} />
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
      <RegisterMapButton chip={chip} />
    </div>
  )
}
