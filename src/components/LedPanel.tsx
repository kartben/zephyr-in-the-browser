/**
 * Dock body for the HT16K33 LED matrix.
 *
 * Paints the chip's 16×8 display RAM as a grid. Brightness scales cell
 * intensity; blink modes flash the whole matrix. Registers opens the shared
 * SVD-style map — same component sensors and RTC use.
 */

import { useEffect, useReducer, useRef } from 'react'
import { RegisterMapButton } from '@/components/RegisterMap'
import type { Ht16k33Chip } from '@/virtio/devices/chips/ht16k33'

const UI_MS = 50

function useChip(chip: Ht16k33Chip) {
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
            const r = Math.round(40 * intensity)
            const b = Math.round(60 * intensity)
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
          } else {
            ctx.fillStyle = 'rgba(255,255,255,0.06)'
          }
          ctx.beginPath()
          ctx.roundRect(x, y, cell, cell, 2)
          ctx.fill()
        }
      }
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }

    const syncBlink = () => {
      if (blinkTimer) {
        clearInterval(blinkTimer)
        blinkTimer = undefined
      }
      const period = blinkPeriodMs(chip.getBlink())
      blinkOn = true
      if (period !== null) {
        blinkTimer = setInterval(() => {
          blinkOn = !blinkOn
          schedule()
        }, period / 2)
      }
      schedule()
    }

    paint()
    const unsub = chip.subscribe(() => {
      syncBlink()
    })
    syncBlink()

    return () => {
      unsub()
      if (frame) cancelAnimationFrame(frame)
      if (blinkTimer) clearInterval(blinkTimer)
    }
  }, [chip])

  return (
    <canvas
      ref={canvasRef}
      aria-label="HT16K33 LED matrix"
      className="w-full rounded border border-border bg-black"
      style={{ imageRendering: 'auto', aspectRatio: `${chip.cols} / ${chip.rows}` }}
    />
  )
}

export function LedMatrixBody({ chip }: { chip: Ht16k33Chip }) {
  useChip(chip)
  const lit = (() => {
    let n = 0
    for (let i = 0; i < chip.rows * chip.cols; i++) if (chip.isLedOn(i)) n++
    return n
  })()
  const brightnessPct = Math.round(((chip.getBrightness() + 1) / 16) * 100)

  return (
    <div className="space-y-2 px-3 py-3">
      <MatrixCanvas chip={chip} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          {chip.isDisplayOn() ? 'on' : 'off'}
          {chip.getBlink() !== 'off' ? ` · blink ${chip.getBlink()}` : ''}
        </span>
        <span className="font-mono tabular-nums">{brightnessPct}%</span>
        <span className="font-mono tabular-nums">
          {lit}/{chip.rows * chip.cols} lit
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Zephyr&apos;s stock{' '}
        <code className="font-mono text-foreground">holtek,ht16k33</code> LED
        driver — 16×8 matrix over I²C at 0x{chip.address.toString(16)}.
      </p>
      <RegisterMapButton chip={chip} />
    </div>
  )
}
