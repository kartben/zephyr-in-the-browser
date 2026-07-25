/**
 * Dock body for the JHD1313 character LCD.
 *
 * Paints the chip's cell buffer as a 5×8-ish monospace grid with an RGB
 * backlight wash from the linked PCA9633-style register file. Controller
 * inspects command-derived state; Registers opens the backlight map.
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import { RegisterMapButton } from '@/components/RegisterMap'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Jhd1313LcdChip } from '@/virtio/devices/chips/jhd1313'

const UI_MS = 100

function useLcd(chip: Jhd1313LcdChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubLcd = chip.subscribe(() => {
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
    const unsubBl = chip.backlight?.subscribe(() => {
      refresh()
    })
    refresh()
    return () => {
      unsubLcd()
      unsubBl?.()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
}

function AuxdisplayControllerButton({ chip }: { chip: Jhd1313LcdChip }) {
  const [open, setOpen] = useState(false)
  useLcd(chip)
  const state = chip.getControllerState()
  const hex = chip.address.toString(16).padStart(2, '0')
  const rows = [
    { label: 'Display', value: state.on ? 'on' : 'off' },
    { label: 'Cursor', value: state.cursor ? 'on' : 'off' },
    { label: 'Blink', value: state.blinking ? 'on' : 'off' },
    { label: 'Entry', value: state.entryIncrement ? 'increment' : 'decrement' },
    {
      label: 'Cursor pos',
      value: `col ${state.cursorColumn}, row ${state.cursorRow}`,
    },
  ]

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Controller
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {chip.name} · 0x{hex}
            </DialogTitle>
            <DialogDescription>
              Command-derived HD44780 state — the LCD address is a command
              stream (0x00/0x80 = command, 0x40 = DDRAM data), not a register
              file. The RGB backlight at 0x62 has the Registers map.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto border-t border-border px-5 py-3">
            <dl className="space-y-1.5">
              {rows.map((row) => (
                <div key={row.label} className="grid grid-cols-[7rem_1fr] gap-2 text-[11px]">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="font-mono tabular-nums text-foreground">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Character-cell canvas: each cell is a fixed glyph slot. Backlight PWM tints
 * the glass; display-off renders nearly black.
 */
function LcdCanvas({ chip }: { chip: Jhd1313LcdChip }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useLcd(chip)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let frame = 0
    let painted = -1
    let blinkPhase = false
    let blinkTimer: ReturnType<typeof setInterval> | undefined

    const cellW = 12
    const cellH = 18
    const padX = 10
    const padY = 8
    const gapX = 2
    const gapY = 4
    const width = padX * 2 + chip.columns * cellW + (chip.columns - 1) * gapX
    const height = padY * 2 + chip.rows * cellH + (chip.rows - 1) * gapY
    canvas.width = width
    canvas.height = height

    const paint = () => {
      frame = 0
      const version = chip.version()
      // Include blink phase so the cursor animates without bumping the chip.
      const stamp = version * 2 + (blinkPhase ? 1 : 0)
      if (stamp === painted) return
      painted = stamp

      const on = chip.isOn()
      const rgb = chip.getBacklightRgb()
      const state = chip.getControllerState()
      const glassR = on ? Math.max(18, Math.round(rgb.r * 0.35 + 12)) : 8
      const glassG = on ? Math.max(22, Math.round(rgb.g * 0.4 + 16)) : 10
      const glassB = on ? Math.max(18, Math.round(rgb.b * 0.35 + 12)) : 8

      ctx.fillStyle = `rgb(${glassR}, ${glassG}, ${glassB})`
      ctx.fillRect(0, 0, width, height)

      ctx.font = `bold ${cellH - 4}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'

      const ink = on
        ? `rgb(${Math.min(30, glassR - 8)}, ${Math.min(40, glassG - 8)}, ${Math.min(30, glassB - 8)})`
        : 'rgb(20, 22, 24)'

      for (let row = 0; row < chip.rows; row++) {
        for (let col = 0; col < chip.columns; col++) {
          const x = padX + col * (cellW + gapX)
          const y = padY + row * (cellH + gapY)
          ctx.fillStyle = `rgba(0,0,0,${on ? 0.12 : 0.25})`
          ctx.fillRect(x, y, cellW, cellH)

          const ch = chip.cells[row * chip.columns + col] ?? 0x20
          const glyph = ch >= 0x20 && ch < 0x7f ? String.fromCharCode(ch) : ' '
          ctx.fillStyle = ink
          ctx.fillText(glyph, x + cellW / 2, y + cellH / 2 + 1)

          const atCursor = state.cursorColumn === col && state.cursorRow === row
          if (on && state.cursor && atCursor && (!state.blinking || blinkPhase)) {
            ctx.fillStyle = ink
            ctx.fillRect(x + 1, y + cellH - 3, cellW - 2, 2)
          }
        }
      }
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }

    paint()
    const unsub = chip.subscribe(schedule)
    const unsubBl = chip.backlight?.subscribe(schedule)
    blinkTimer = setInterval(() => {
      blinkPhase = !blinkPhase
      schedule()
    }, 500)

    return () => {
      unsub()
      unsubBl?.()
      if (frame) cancelAnimationFrame(frame)
      if (blinkTimer) clearInterval(blinkTimer)
    }
  }, [chip])

  return (
    <canvas
      ref={canvasRef}
      aria-label="JHD1313 character LCD"
      className="w-full rounded border border-border"
      style={{ imageRendering: 'auto', aspectRatio: `${chip.columns * 3} / ${chip.rows * 4}` }}
    />
  )
}

export function AuxdisplayBody({ chip }: { chip: Jhd1313LcdChip }) {
  useLcd(chip)
  const rgb = chip.getBacklightRgb()
  const bl = chip.backlight

  return (
    <div className="space-y-2 px-3 py-3">
      <LcdCanvas chip={chip} />
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span
          className="inline-block size-3 rounded-sm border border-border"
          style={{ backgroundColor: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` }}
          title="Backlight RGB"
        />
        <span className="font-mono tabular-nums">
          R{rgb.r} G{rgb.g} B{rgb.b}
        </span>
        {bl ? (
          <span className="text-muted-foreground/80">
            · backlight@
            {bl.address.toString(16).padStart(2, '0')}
          </span>
        ) : null}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Zephyr&apos;s stock{' '}
        <code className="font-mono text-foreground">jhd,jhd1313</code> auxdisplay
        driver — LCD commands at 0x{chip.address.toString(16)}, RGB backlight
        register file at 0x62.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <AuxdisplayControllerButton chip={chip} />
        {bl ? <RegisterMapButton chip={bl} /> : null}
      </div>
    </div>
  )
}
