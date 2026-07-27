/**
 * Dock body for character aux displays (JHD1313 LCD + PT6314 VFD).
 *
 * Shared Status / Registers affordances; the canvas branches on part —
 * Grove RGB LCD wash vs Newhaven/Futaba-style cyan-green VFD phosphor —
 * without cloning the dock shell. Both paint the same 5×8 CGROM bitmaps
 * (PT6314-001 English/Japanese ASCII matches HD44780U A00).
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
  HD44780_GLYPH_H,
  HD44780_GLYPH_W,
  HD44780_GLYPHS,
} from '@/components/hd44780Glyphs'
import {
  isJhd1313Lcd,
  type Jhd1313LcdChip,
} from '@/virtio/devices/chips/jhd1313'
import {
  isPt6314,
  type Pt6314Chip,
} from '@/virtio/devices/chips/pt6314'

const UI_MS = 100

/**
 * JHD1313 FP-RGB mechanical (datasheet §2): character is a 5×8 CGROM field
 * (5×7 glyph + cursor row) at 2.95×4.35 mm; character pitch 3.65×5.05 mm.
 * Cell = exact 5×8 dot grid so ink fills the background rectangle.
 */
const LCD_DOT_PX = 3
const LCD_CELL_W = HD44780_GLYPH_W * LCD_DOT_PX
const LCD_CELL_H = HD44780_GLYPH_H * LCD_DOT_PX
/** Inter-character gap ≈ (pitch − size): 0.7/2.95 · cellW, 0.7/4.35 · cellH. */
const LCD_GAP_X = Math.max(1, Math.round((0.7 / 2.95) * LCD_CELL_W))
const LCD_GAP_Y = Math.max(1, Math.round((0.7 / 4.35) * LCD_CELL_H))
const LCD_PAD_X = 10
const LCD_PAD_Y = 8

/**
 * PT6314 CGROM is also 5×8 (datasheet §5.3 / §12.1). Newhaven modules show
 * soft phosphor anodes with a mild bloom — not hard LCD squares. Cell is
 * still the 5×8 grid; glow uses source-over (not additive) so dense glyphs
 * stay even with sparse ones.
 */
const VFD_DOT_PX = 4
const VFD_CELL_W = HD44780_GLYPH_W * VFD_DOT_PX
const VFD_CELL_H = HD44780_GLYPH_H * VFD_DOT_PX
const VFD_GAP_X = 5
const VFD_GAP_Y = 7
const VFD_PAD_X = 16
const VFD_PAD_Y = 14
/** Core anode radius (bitmap pass). */
const VFD_CORE_R = VFD_DOT_PX * 0.4
/** Soft halo around each anode (source-over, not additive). */
const VFD_HALO_R = VFD_DOT_PX * 0.85
/** Mild whole-field bloom blur (px) — kept light so dense glyphs don't wash out. */
const VFD_BLOOM_BLUR = 2
const VFD_BLOOM_ALPHA = 0.18

/**
 * Paint one HD44780 CGROM glyph flush to the cell — each of the 5×8 dots
 * owns an equal tile of the background rectangle (no inset / centering).
 */
function paintLcdGlyph(
  ctx: CanvasRenderingContext2D,
  ch: number,
  cellX: number,
  cellY: number,
) {
  if (ch < 0x20 || ch > 0x7f) return
  const rows = HD44780_GLYPHS[ch - 0x20]
  if (!rows) return
  for (let r = 0; r < HD44780_GLYPH_H; r++) {
    const bits = rows[r] ?? 0
    for (let c = 0; c < HD44780_GLYPH_W; c++) {
      if (bits & (0x80 >> c)) {
        ctx.fillRect(
          cellX + c * LCD_DOT_PX,
          cellY + r * LCD_DOT_PX,
          LCD_DOT_PX,
          LCD_DOT_PX,
        )
      }
    }
  }
}

/** Collect lit anode centers for a CGROM code (or a solid blink block). */
function vfdLitCenters(
  ch: number | 'block',
  cellX: number,
  cellY: number,
): { x: number; y: number }[] {
  const half = VFD_DOT_PX / 2
  const out: { x: number; y: number }[] = []
  if (ch === 'block') {
    for (let r = 0; r < HD44780_GLYPH_H; r++) {
      for (let c = 0; c < HD44780_GLYPH_W; c++) {
        out.push({ x: cellX + c * VFD_DOT_PX + half, y: cellY + r * VFD_DOT_PX + half })
      }
    }
    return out
  }
  if (ch < 0x20 || ch > 0x7f) return out
  const rows = HD44780_GLYPHS[ch - 0x20]
  if (!rows) return out
  for (let r = 0; r < HD44780_GLYPH_H; r++) {
    const bits = rows[r] ?? 0
    for (let c = 0; c < HD44780_GLYPH_W; c++) {
      if (bits & (0x80 >> c)) {
        out.push({ x: cellX + c * VFD_DOT_PX + half, y: cellY + r * VFD_DOT_PX + half })
      }
    }
  }
  return out
}

/** Stamp solid anode discs into a context (used for the bloom underlay). */
function stampVfdCores(
  ctx: CanvasRenderingContext2D,
  centers: readonly { x: number; y: number }[],
  fill: string,
  radius: number,
) {
  ctx.fillStyle = fill
  for (const { x, y } of centers) {
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * Soft phosphor anodes. Avoid `lighter` compositing — additive bloom makes
 * dense CGROM strokes (w/m/e) wash out far brighter than sparse ones (_, .).
 * One mild blurred underlay + per-dot radial core keeps glow even.
 */
function paintVfdAnodes(
  ctx: CanvasRenderingContext2D,
  centers: readonly { x: number; y: number }[],
  level: number,
) {
  if (level <= 0 || centers.length === 0) return

  // Gentle field bloom (source-over, single pass) — soft air, not a hot wash.
  ctx.save()
  ctx.globalAlpha = VFD_BLOOM_ALPHA * level
  ctx.filter = `blur(${VFD_BLOOM_BLUR}px)`
  stampVfdCores(
    ctx,
    centers,
    `rgb(${Math.round(45 * level + 25)}, ${Math.round(210 * level)}, ${Math.round(150 * level)})`,
    VFD_CORE_R * 1.2,
  )
  ctx.restore()

  // Even per-anode glow: short halo + soft core (no additive stacking).
  for (const { x: cx, y: cy } of centers) {
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, VFD_HALO_R)
    core.addColorStop(0, `rgba(215, 255, 230, ${0.95 * level})`)
    core.addColorStop(0.28, `rgba(110, 245, 190, ${0.9 * level})`)
    core.addColorStop(0.5, `rgba(70, 220, 165, ${0.55 * level})`)
    core.addColorStop(0.72, `rgba(45, 170, 125, ${0.18 * level})`)
    core.addColorStop(1, 'rgba(25, 100, 70, 0)')
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(cx, cy, VFD_HALO_R, 0, Math.PI * 2)
    ctx.fill()
  }
}

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
            <DialogDescription className="sr-only">
              Live display state
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
 * Character-cell canvas. LCD: RGB backlight wash. VFD: dark glass + cyan-green
 * phosphor dots (Newhaven / Futaba M202MD15FA PT6314 look).
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

    const cellW = vfd ? VFD_CELL_W : LCD_CELL_W
    const cellH = vfd ? VFD_CELL_H : LCD_CELL_H
    const padX = vfd ? VFD_PAD_X : LCD_PAD_X
    const padY = vfd ? VFD_PAD_Y : LCD_PAD_Y
    const gapX = vfd ? VFD_GAP_X : LCD_GAP_X
    const gapY = vfd ? VFD_GAP_Y : LCD_GAP_Y
    const width = padX * 2 + chip.columns * cellW + (chip.columns - 1) * gapX
    const height = padY * 2 + chip.rows * cellH + (chip.rows - 1) * gapY
    canvas.width = width
    canvas.height = height
    // Keep CSS box in lockstep with the bitmap so pixelated scale stays square.
    canvas.style.aspectRatio = `${width} / ${height}`

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
        // Newhaven-style cyan-green VFD: dark filter glass + soft phosphor anodes.
        const level = on ? chip.getBrightness() / 4 : 0
        ctx.fillStyle = '#040608'
        ctx.fillRect(0, 0, width, height)

        // Soft tube wash behind the character field.
        const wash = ctx.createRadialGradient(
          width / 2,
          height / 2,
          Math.min(width, height) * 0.12,
          width / 2,
          height / 2,
          Math.max(width, height) * 0.75,
        )
        wash.addColorStop(0, `rgba(12, 48, 36, ${0.45 * level})`)
        wash.addColorStop(0.55, `rgba(8, 28, 22, ${0.18 * level})`)
        wash.addColorStop(1, 'rgba(0, 0, 0, 0)')
        ctx.fillStyle = wash
        ctx.fillRect(0, 0, width, height)

        // Dim character-cell slots, then one bloom/core pass for all lit anodes.
        const dimSlot = `rgba(16, 36, 28, ${0.5 + 0.15 * level})`
        const lit: { x: number; y: number }[] = []

        for (let row = 0; row < chip.rows; row++) {
          for (let col = 0; col < chip.columns; col++) {
            const x = padX + col * (cellW + gapX)
            const y = padY + row * (cellH + gapY)
            ctx.fillStyle = dimSlot
            ctx.fillRect(x, y, cellW, cellH)

            if (!on || level <= 0) continue

            const ch = chip.cells[row * chip.columns + col] ?? 0x20
            const atCursor = state.cursorColumn === col && state.cursorRow === row
            const blinkOn = state.blinking && atCursor && blinkPhase

            if (blinkOn) {
              lit.push(...vfdLitCenters('block', x, y))
            } else {
              lit.push(...vfdLitCenters(ch, x, y))
            }

            if (state.cursor && atCursor && (!state.blinking || blinkPhase)) {
              // PT6314 cursor OR's onto the 8th CGROM row (datasheet §5.4).
              const half = VFD_DOT_PX / 2
              const cy = y + (HD44780_GLYPH_H - 1) * VFD_DOT_PX + half
              for (let c = 0; c < HD44780_GLYPH_W; c++) {
                lit.push({ x: x + c * VFD_DOT_PX + half, y: cy })
              }
            }
          }
        }

        paintVfdAnodes(ctx, lit, level)
        return
      }

      // Grove JHD1313 LCD: RGB backlight wash + crisp 5×8 CGROM dots.
      const lcd = chip as Jhd1313LcdChip
      const rgb = lcd.getBacklightRgb()
      // Luminous wash — dim navy swallows near-black glyphs on saturated blue.
      const glassR = on ? Math.max(36, Math.round(rgb.r * 0.72 + 28)) : 8
      const glassG = on ? Math.max(40, Math.round(rgb.g * 0.78 + 32)) : 10
      const glassB = on ? Math.max(36, Math.round(rgb.b * 0.72 + 28)) : 8

      ctx.fillStyle = `rgb(${glassR}, ${glassG}, ${glassB})`
      ctx.fillRect(0, 0, width, height)

      // Punchy near-black ink (a touch of backlight tint, never crushed to #000).
      const ink = on
        ? `rgb(${Math.round(4 + glassR * 0.03)}, ${Math.round(5 + glassG * 0.03)}, ${Math.round(6 + glassB * 0.04)})`
        : 'rgb(28, 30, 32)'

      for (let row = 0; row < chip.rows; row++) {
        for (let col = 0; col < chip.columns; col++) {
          const x = padX + col * (cellW + gapX)
          const y = padY + row * (cellH + gapY)
          ctx.fillStyle = `rgba(0,0,0,${on ? 0.1 : 0.25})`
          ctx.fillRect(x, y, cellW, cellH)

          const ch = chip.cells[row * chip.columns + col] ?? 0x20
          ctx.fillStyle = ink
          paintLcdGlyph(ctx, ch, x, y)

          const atCursor = state.cursorColumn === col && state.cursorRow === row
          if (on && state.cursor && atCursor && (!state.blinking || blinkPhase)) {
            // HD44780 cursor occupies the bottom (8th) CGROM row.
            ctx.fillStyle = ink
            ctx.fillRect(x, y + (HD44780_GLYPH_H - 1) * LCD_DOT_PX, cellW, LCD_DOT_PX)
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
        // LCD stays crisp/pixelated; VFD soft phosphor needs antialiased scale.
        imageRendering: vfd ? 'auto' : 'pixelated',
        ...(vfd
          ? { background: '#040608', aspectRatio: `${chip.columns * 3} / ${chip.rows * 4}` }
          : null),
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
                ? `rgb(${Math.round(70 * (chip.getBrightness() / 4))}, ${Math.round(235 * (chip.getBrightness() / 4))}, ${Math.round(175 * (chip.getBrightness() / 4))})`
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
