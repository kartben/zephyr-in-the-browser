/**
 * Dock body for character aux displays (JHD1313 LCD + PT6314 VFD).
 *
 * Shared Status / Registers affordances; the canvas branches on part —
 * Grove RGB LCD wash vs Futaba-style cyan VFD phosphor — without cloning the
 * dock shell.
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
import {
  isJhd1313Lcd,
  type Jhd1313LcdChip,
} from '@/virtio/devices/chips/jhd1313'
import {
  isPt6314,
  type Pt6314Chip,
} from '@/virtio/devices/chips/pt6314'

const UI_MS = 100

/** Common surface both character panels paint and inspect. */
export type AuxdisplayChip = Jhd1313LcdChip | Pt6314Chip

function useAuxdisplay(chip: AuxdisplayChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsub = chip.subscribe(() => {
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
    const unsubBl =
      isJhd1313Lcd(chip) && chip.backlight
        ? chip.backlight.subscribe(() => {
            refresh()
          })
        : undefined
    refresh()
    return () => {
      unsub()
      unsubBl?.()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
}

function AuxdisplayControllerButton({ chip }: { chip: AuxdisplayChip }) {
  const [open, setOpen] = useState(false)
  useAuxdisplay(chip)
  const state = chip.getControllerState()
  const hex = chip.address.toString(16).padStart(2, '0')
  const vfd = isPt6314(chip)
  const rows = [
    { label: 'Display', value: state.on ? 'on' : 'off' },
    { label: 'Cursor', value: state.cursor ? 'on' : 'off' },
    { label: 'Blink', value: state.blinking ? 'on' : 'off' },
    { label: 'Entry', value: state.entryIncrement ? 'increment' : 'decrement' },
    {
      label: 'Cursor pos',
      value: `col ${state.cursorColumn}, row ${state.cursorRow}`,
    },
    ...(vfd
      ? [{ label: 'Brightness', value: `${chip.getBrightness()} / 4` }]
      : []),
  ]

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Status
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {chip.name} · {vfd ? `CS${chip.address}` : `0x${hex}`}
            </DialogTitle>
            <DialogDescription>
              {vfd ? (
                <>
                  Live display on/off, cursor, blink, and brightness from the
                  guest&apos;s SPI instruction writes. Registers opens the
                  start-byte / command / data map.
                </>
              ) : (
                <>
                  Live display on/off, cursor, and blink from the guest&apos;s
                  instruction writes. LCD registers opens the command/data map;
                  backlight PWM is on the separate chip at 0x62.
                </>
              )}
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
 * Character-cell canvas. LCD: RGB backlight wash. VFD: dark glass + cyan
 * phosphor glow (Futaba M202MD15FA / PT6314 look).
 */
function AuxdisplayCanvas({ chip }: { chip: AuxdisplayChip }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useAuxdisplay(chip)
  const vfd = isPt6314(chip)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let frame = 0
    let painted = -1
    let blinkPhase = false
    let blinkTimer: ReturnType<typeof setInterval> | undefined

    const cellW = vfd ? 10 : 12
    const cellH = vfd ? 16 : 18
    const padX = vfd ? 14 : 10
    const padY = vfd ? 12 : 8
    const gapX = vfd ? 3 : 2
    const gapY = vfd ? 6 : 4
    const width = padX * 2 + chip.columns * cellW + (chip.columns - 1) * gapX
    const height = padY * 2 + chip.rows * cellH + (chip.rows - 1) * gapY
    canvas.width = width
    canvas.height = height

    const paint = () => {
      frame = 0
      const version = chip.version()
      const brightness = vfd ? chip.getBrightness() : 0
      const stamp = version * 8 + (blinkPhase ? 4 : 0) + brightness
      if (stamp === painted) return
      painted = stamp

      const on = chip.isOn()
      const state = chip.getControllerState()

      if (vfd) {
        // Futaba-style blue-cyan VFD: near-black filter glass, phosphor glow.
        const level = on ? chip.getBrightness() / 4 : 0
        ctx.fillStyle = '#05070a'
        ctx.fillRect(0, 0, width, height)

        // Soft inner vignette.
        const wash = ctx.createRadialGradient(
          width / 2,
          height / 2,
          Math.min(width, height) * 0.15,
          width / 2,
          height / 2,
          Math.max(width, height) * 0.7,
        )
        wash.addColorStop(0, `rgba(20, 40, 55, ${0.35 * level})`)
        wash.addColorStop(1, 'rgba(0, 0, 0, 0)')
        ctx.fillStyle = wash
        ctx.fillRect(0, 0, width, height)

        const glow = Math.round(140 + 100 * level)
        const ink = on
          ? `rgb(${Math.round(80 * level)}, ${Math.round(200 * level)}, ${glow})`
          : 'rgb(18, 22, 26)'
        const dimSlot = 'rgba(30, 50, 60, 0.35)'

        ctx.font = `bold ${cellH - 3}px ui-monospace, SFMono-Regular, Menlo, monospace`
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'

        for (let row = 0; row < chip.rows; row++) {
          for (let col = 0; col < chip.columns; col++) {
            const x = padX + col * (cellW + gapX)
            const y = padY + row * (cellH + gapY)
            ctx.fillStyle = dimSlot
            ctx.fillRect(x, y, cellW, cellH)

            const ch = chip.cells[row * chip.columns + col] ?? 0x20
            const glyph = ch >= 0x20 && ch < 0x7f ? String.fromCharCode(ch) : ' '
            const atCursor = state.cursorColumn === col && state.cursorRow === row
            const blinkOn = on && state.blinking && atCursor && blinkPhase

            if (on && level > 0) {
              // Soft bloom behind lit glyphs.
              if (glyph !== ' ' || blinkOn) {
                ctx.save()
                ctx.shadowColor = `rgba(80, 220, 255, ${0.55 * level})`
                ctx.shadowBlur = 6 + 4 * level
                ctx.fillStyle = ink
                ctx.fillText(glyph === ' ' && blinkOn ? '█' : glyph, x + cellW / 2, y + cellH / 2 + 1)
                ctx.restore()
              } else {
                ctx.fillStyle = ink
                ctx.fillText(glyph, x + cellW / 2, y + cellH / 2 + 1)
              }
            } else {
              ctx.fillStyle = ink
              ctx.fillText(glyph, x + cellW / 2, y + cellH / 2 + 1)
            }

            if (on && state.cursor && atCursor && (!state.blinking || blinkPhase)) {
              ctx.fillStyle = ink
              ctx.shadowColor = `rgba(80, 220, 255, ${0.45 * level})`
              ctx.shadowBlur = 4
              ctx.fillRect(x + 1, y + cellH - 3, cellW - 2, 2)
              ctx.shadowBlur = 0
            }
          }
        }
        return
      }

      // Grove JHD1313 LCD path (unchanged wash + ink).
      const lcd = chip as Jhd1313LcdChip
      const rgb = lcd.getBacklightRgb()
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
    const unsubBl =
      isJhd1313Lcd(chip) && chip.backlight ? chip.backlight.subscribe(schedule) : undefined
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
  }, [chip, vfd])

  return (
    <canvas
      ref={canvasRef}
      aria-label={vfd ? 'PT6314 character VFD' : 'JHD1313 character LCD'}
      className="w-full rounded border border-border"
      style={{
        imageRendering: 'auto',
        aspectRatio: `${chip.columns * 3} / ${chip.rows * 4}`,
        ...(vfd ? { background: '#05070a' } : null),
      }}
    />
  )
}

export function AuxdisplayBody({ chip }: { chip: AuxdisplayChip }) {
  useAuxdisplay(chip)
  const vfd = isPt6314(chip)
  const lcd = isJhd1313Lcd(chip) ? chip : null
  const rgb = lcd?.getBacklightRgb()
  const bl = lcd?.backlight

  return (
    <div className="space-y-2 px-3 py-3">
      <AuxdisplayCanvas chip={chip} />
      {lcd && rgb ? (
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
      ) : null}
      {vfd ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span
            className="inline-block size-3 rounded-sm border border-border"
            style={{
              backgroundColor: chip.isOn()
                ? `rgb(${Math.round(40 * (chip.getBrightness() / 4))}, ${Math.round(180 * (chip.getBrightness() / 4))}, ${Math.round(220 * (chip.getBrightness() / 4))})`
                : '#111',
            }}
            title="VFD brightness"
          />
          <span className="font-mono tabular-nums">
            brightness {chip.getBrightness()}/4
          </span>
          <span className="text-muted-foreground/80">· SPI CS{chip.address}</span>
        </div>
      ) : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {vfd ? (
          <>
            Zephyr&apos;s stock{' '}
            <code className="font-mono text-foreground">ptc,pt6314</code> auxdisplay
            driver on SPI — {chip.columns}×{chip.rows} character VFD.
          </>
        ) : (
          <>
            Zephyr&apos;s stock{' '}
            <code className="font-mono text-foreground">jhd,jhd1313</code> auxdisplay
            driver — {chip.columns}×{chip.rows} LCD at 0x{chip.address.toString(16)},
            RGB backlight at 0x62.
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AuxdisplayControllerButton chip={chip} />
        <RegisterMapButton
          chip={chip}
          label={vfd ? undefined : `LCD registers (${chip.registers.length})`}
        />
        {bl ? (
          <RegisterMapButton chip={bl} label={`Backlight registers (${bl.registers.length})`} />
        ) : null}
      </div>
    </div>
  )
}
