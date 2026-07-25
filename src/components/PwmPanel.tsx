/**
 * Dock body for any {@link PwmChip}.
 *
 * Paints an annotated ~1.25-period square wave for the selected channel, a
 * duty strip sized from `decl.channelCount`, optional detail metrics, and the
 * shared Registers dialog. Provider-agnostic — do not import PCA9685 here.
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import { RegisterMapButton } from '@/components/RegisterMap'
import {
  formatPwmDuration,
  formatPwmDuty,
  formatPwmFrequency,
  type PwmChannel,
  type PwmChip,
} from '@/virtio/devices/pwm/model'

const UI_MS = 50

function useChip(chip: PwmChip) {
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

function WaveformCanvas({ ch }: { ch: PwmChannel }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

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

    const padL = 10
    const padR = 10
    const padT = 28
    const padB = 28
    const plotW = cssW - padL - padR
    const plotH = cssH - padT - padB
    const yHigh = padT + 8
    const yLow = padT + plotH - 8

    ctx.clearRect(0, 0, cssW, cssH)
    ctx.fillStyle = '#0c0e12'
    ctx.fillRect(0, 0, cssW, cssH)

    // Faint grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (let i = 1; i < 4; i++) {
      const x = padL + (plotW * i) / 4
      ctx.beginPath()
      ctx.moveTo(x, padT)
      ctx.lineTo(x, padT + plotH)
      ctx.stroke()
    }

    const periods = 1.25
    const xAt = (tNorm: number) => padL + (tNorm / periods) * plotW

    const flat = ch.fullOn || ch.fullOff || ch.periodNs <= 0
    const duty = flat ? (ch.fullOn ? 1 : 0) : Math.max(0, Math.min(1, ch.duty))
    const edge = duty // end of high within first period

    // Trace
    ctx.strokeStyle = '#3ecf8e'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (ch.fullOff || (flat && duty === 0)) {
      ctx.moveTo(padL, yLow)
      ctx.lineTo(padL + plotW, yLow)
    } else if (ch.fullOn) {
      ctx.moveTo(padL, yHigh)
      ctx.lineTo(padL + plotW, yHigh)
    } else {
      ctx.moveTo(xAt(0), yLow)
      ctx.lineTo(xAt(0), yHigh)
      ctx.lineTo(xAt(edge), yHigh)
      ctx.lineTo(xAt(edge), yLow)
      ctx.lineTo(xAt(1), yLow)
      ctx.lineTo(xAt(1), yHigh)
      ctx.lineTo(xAt(1 + Math.min(edge, 0.25)), yHigh)
    }
    ctx.stroke()

    // Falling-edge guide
    if (!flat && edge > 0 && edge < 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(xAt(edge), padT)
      ctx.lineTo(xAt(edge), padT + plotH)
      ctx.stroke()
      ctx.setLineDash([])
    }

    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'left'
    if (!flat) {
      ctx.fillText('HIGH', xAt(edge / 2) - 12, yHigh - 6)
      ctx.fillText('LOW', xAt((edge + 1) / 2) - 10, yLow + 14)
    } else {
      ctx.fillText(ch.fullOn ? 'full-on' : 'full-off', padL + 4, yHigh - 6)
    }

    // Duty / freq chip
    const chipLabel = flat
      ? ch.fullOn
        ? 'full-on'
        : 'full-off'
      : `${formatPwmDuty(duty)} duty · ${formatPwmFrequency(ch.periodNs)}`
    ctx.textAlign = 'right'
    ctx.fillStyle = 'rgba(62,207,142,0.9)'
    ctx.fillText(chipLabel, cssW - padR, 16)

    // Period bracket
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.textAlign = 'center'
    const yBracket = cssH - 10
    const x0 = xAt(0)
    const xT = xAt(1)
    ctx.beginPath()
    ctx.moveTo(x0, yBracket - 4)
    ctx.lineTo(x0, yBracket)
    ctx.lineTo(xT, yBracket)
    ctx.lineTo(xT, yBracket - 4)
    ctx.stroke()
    ctx.fillText(`T = ${formatPwmDuration(ch.periodNs)}`, (x0 + xT) / 2, yBracket - 8)

    if (!flat && duty > 0.02 && duty < 0.98) {
      ctx.textAlign = 'center'
      ctx.fillText(`t_high = ${formatPwmDuration(ch.pulseNs)}`, xAt(edge / 2), padT - 8)
      ctx.fillText(
        `t_low = ${formatPwmDuration(ch.periodNs - ch.pulseNs)}`,
        xAt((edge + 1) / 2),
        padT - 8,
      )
    }

    // X ticks
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.textAlign = 'center'
    for (const [label, t] of [
      ['0', 0],
      ['T/2', 0.5],
      ['T', 1],
      ['1.25T', 1.25],
    ] as const) {
      ctx.fillText(label, xAt(t), cssH - 2)
    }
  }, [ch])

  return (
    <canvas
      ref={canvasRef}
      aria-label={`PWM channel ${ch.index} waveform`}
      className="h-[168px] w-full rounded border border-border bg-black"
    />
  )
}

function ChannelStrip({
  chip,
  selected,
  onSelect,
}: {
  chip: PwmChip
  selected: number
  onSelect: (n: number) => void
}) {
  const n = chip.decl.channelCount
  return (
    <div className="flex items-end gap-0.5" role="listbox" aria-label="PWM channels">
      {Array.from({ length: n }, (_, i) => {
        const ch = chip.getChannel(i)
        const h = Math.round(2 + ch.duty * 22)
        const active = i === selected
        return (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={active}
            title={`CH${i} · ${formatPwmDuty(ch.duty)}`}
            onClick={() => onSelect(i)}
            className={
              active
                ? 'flex flex-1 flex-col items-center gap-0.5 rounded border border-primary/70 bg-primary/10 px-0.5 py-1'
                : 'flex flex-1 flex-col items-center gap-0.5 rounded border border-transparent px-0.5 py-1 hover:bg-muted/40'
            }
          >
            <span
              className={active ? 'w-full rounded-sm bg-primary' : 'w-full rounded-sm bg-success/70'}
              style={{ height: h }}
            />
            <span className="font-mono text-[8px] tabular-nums text-muted-foreground">
              {i === selected ? `CH${i}` : i}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function PwmBody({ chip }: { chip: PwmChip }) {
  useChip(chip)
  const [selected, setSelected] = useState(0)
  const sel = Math.min(selected, Math.max(0, chip.decl.channelCount - 1))
  const ch = chip.getChannel(sel)

  const details = (chip.decl.detailKeys ?? [])
    .map((key) => {
      const value = chip.getDetail?.(key)
      return value ? `${key === 'prescale' ? 'PRE_SCALE' : key} ${value}` : null
    })
    .filter(Boolean)

  const countHint =
    ch.fullOn || ch.fullOff
      ? ch.fullOn
        ? 'full-on'
        : 'full-off'
      : `duty ${formatPwmDuty(ch.duty)}`

  return (
    <div className="space-y-2 px-3 py-3">
      <WaveformCanvas ch={ch} />
      <ChannelStrip chip={chip} selected={sel} onSelect={setSelected} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          CH{sel} · {countHint}
          {ch.inverted ? ' · inv' : ''}
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
        {chip.decl.channelCount}-channel PWM
        {chip.decl.periodScope === 'controller' ? ' (shared period)' : ''}
        {chip.address != null ? ` at 0x${chip.address.toString(16)}` : ''}.
      </p>
      <RegisterMapButton chip={chip} />
    </div>
  )
}
