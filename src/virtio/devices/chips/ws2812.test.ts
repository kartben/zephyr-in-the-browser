import { describe, expect, it } from 'vitest'
import {
  createWs2812,
  isWs2812,
  ws2812Meta,
  type Ws2812ColorId,
} from './ws2812'

/** Encode one color channel the way Zephyr's `ws2812_spi_ser` does (8-bit symbols). */
function encodeChannel(value: number, one: number, zero: number): number[] {
  const out: number[] = []
  for (let i = 7; i >= 0; i--) {
    out.push(value & (1 << i) ? one : zero)
  }
  return out
}

function encodePixel(
  rgb: { r: number; g: number; b: number; w?: number },
  order: readonly Ws2812ColorId[],
  one: number,
  zero: number,
): Uint8Array {
  const bytes: number[] = []
  for (const ch of order) {
    const v = ch === 'w' ? (rgb.w ?? 0) : rgb[ch]
    bytes.push(...encodeChannel(v, one, zero))
  }
  return Uint8Array.from(bytes)
}

function encodeStrip(
  pixels: Array<{ r: number; g: number; b: number; w?: number }>,
  order: readonly Ws2812ColorId[] = ['g', 'r', 'b'],
  one = ws2812Meta.DEFAULT_ONE_FRAME,
  zero = ws2812Meta.DEFAULT_ZERO_FRAME,
): Uint8Array {
  const parts = pixels.map((p) => encodePixel(p, order, one, zero))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const part of parts) {
    out.set(part, o)
    o += part.length
  }
  return out
}

function xfer(chip: ReturnType<typeof createWs2812>, tx: Uint8Array) {
  const rx = new Uint8Array(tx.length)
  return chip.transfer(tx, rx, { csChange: true, bitsPerWord: 8, mode: 0, freq: 4_000_000 })
}

describe('WS2812 SPI LED strip', () => {
  it('duck-types as WS2812', () => {
    const chip = createWs2812()
    expect(isWs2812(chip)).toBe(true)
    expect(chip.chainLength).toBe(16)
    expect(chip.moduleCount).toBe(16)
  })

  it('decodes a GRB pixel from 8-bit one/zero frames', () => {
    const chip = createWs2812({ chainLength: 1 })
    const tx = encodeStrip([{ r: 0x10, g: 0x20, b: 0x30 }])
    expect(tx.length).toBe(ws2812Meta.bytesPerRgbPixel())
    expect(xfer(chip, tx)).toBe(true)
    expect(chip.getPixelRgb(0)).toEqual({ r: 0x10, g: 0x20, b: 0x30, w: 0 })
  })

  it('walks a chasing pixel like samples/drivers/led/led_strip', () => {
    const chip = createWs2812({ chainLength: 4 })
    const colors = [
      { r: 16, g: 0, b: 0 },
      { r: 0, g: 16, b: 0 },
      { r: 0, g: 0, b: 16 },
    ]

    for (const color of colors) {
      for (let cursor = 0; cursor < 4; cursor++) {
        const frame = Array.from({ length: 4 }, (_, i) =>
          i === cursor ? color : { r: 0, g: 0, b: 0 },
        )
        xfer(chip, encodeStrip(frame))
        for (let i = 0; i < 4; i++) {
          expect(chip.getModuleRgb(i)).toEqual(
            i === cursor ? { ...color, w: 0 } : { r: 0, g: 0, b: 0, w: 0 },
          )
        }
      }
    }
  })

  it('honours RGB color-mapping when not GRB', () => {
    const chip = createWs2812({
      chainLength: 1,
      colorOrder: ['r', 'g', 'b'],
    })
    const tx = encodeStrip([{ r: 1, g: 2, b: 3 }], ['r', 'g', 'b'])
    xfer(chip, tx)
    expect(chip.getPixelRgb(0)).toEqual({ r: 1, g: 2, b: 3, w: 0 })
  })

  it('rejects empty transfers and ignores incomplete trailing bytes', () => {
    const chip = createWs2812({ chainLength: 2 })
    expect(xfer(chip, new Uint8Array(0))).toBe(false)

    // One full pixel + a few junk bytes — first pixel updates, second stays off.
    const one = encodeStrip([{ r: 0xff, g: 0, b: 0 }])
    const short = new Uint8Array(one.length + 3)
    short.set(one)
    short.set([0x70, 0x40, 0x70], one.length)
    expect(xfer(chip, short)).toBe(true)
    expect(chip.getPixelRgb(0)).toEqual({ r: 0xff, g: 0, b: 0, w: 0 })
    expect(chip.getPixelRgb(1)).toEqual({ r: 0, g: 0, b: 0, w: 0 })
  })

  it('notifies once per transfer, not per byte', () => {
    const chip = createWs2812({ chainLength: 2 })
    let ticks = 0
    chip.subscribe(() => {
      ticks++
    })
    xfer(chip, encodeStrip([{ r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }]))
    expect(ticks).toBe(1)
    // Identical frame — no notify.
    xfer(chip, encodeStrip([{ r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }]))
    expect(ticks).toBe(1)
  })

  it('treats non-one symbols as zero bits', () => {
    const chip = createWs2812({ chainLength: 1 })
    // All zero-frame bytes → black; mix junk with zero → still black for '0'.
    const tx = new Uint8Array(24).fill(0x00)
    expect(xfer(chip, tx)).toBe(true)
    expect(chip.getPixelRgb(0)).toEqual({ r: 0, g: 0, b: 0, w: 0 })
  })

  it('exposes brightest pixel for the collapsed badge', () => {
    const chip = createWs2812({ chainLength: 3 })
    xfer(
      chip,
      encodeStrip([
        { r: 1, g: 0, b: 0 },
        { r: 0, g: 40, b: 0 },
        { r: 0, g: 0, b: 2 },
      ]),
    )
    expect(chip.getRgb()).toEqual({ r: 0, g: 40, b: 0, w: 0 })
  })
})
