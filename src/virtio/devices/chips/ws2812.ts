/**
 * Worldsemi WS2812 LED strip — page-side SPI bitstream model.
 *
 * Zephyr's `drivers/led_strip/ws2812_spi.c` does not speak "real" SPI to the
 * part: it abuses MOSI as a waveform generator, expanding each WS2812 data bit
 * into an N-bit symbol (`spi-one-frame` / `spi-zero-frame`) packed into 8-bit
 * SPI frames. Timing on silicon is sub-microsecond; here we only decode the
 * logical bitstream and paint the dock — wall-clock pulse widths are ignored
 * (guest `reset-delay` is just `k_usleep`). One `led_strip_update_rgb` is one
 * virtqueue transfer of 24×chain-length bytes when bits-per-symbol is 8.
 *
 * Compatible: `worldsemi,ws2812-spi`. Stock sample: `samples/drivers/led/led_strip`.
 */

import type { SpiChip, SpiTransferOpts } from '../spi'
import type { Rgbw } from './lp50xx'

/** On-wire color channel ids matching Zephyr's `dt-bindings/led/led.h`. */
export type Ws2812ColorId = 'w' | 'r' | 'g' | 'b'

const SPI_FRAME_BITS = 8
const BITS_PER_CHANNEL = 8

export interface Ws2812Options {
  cs?: number
  name?: string
  /** Daisy-chain length (`chain-length` in DT). */
  chainLength?: number
  /** SPI symbol for a '1' bit (`spi-one-frame`). */
  oneFrame?: number
  /** SPI symbol for a '0' bit (`spi-zero-frame`). */
  zeroFrame?: number
  /** Bits per WS2812 data bit; Zephyr default 8. */
  bitsPerSymbol?: number
  /**
   * Wire order (`color-mapping`). GRB is the WS2812 default; pass RGB etc.
   * when the overlay says so.
   */
  colorOrder?: readonly Ws2812ColorId[]
}

export interface Ws2812Chip extends SpiChip {
  readonly chainLength: number
  /** Same as {@link chainLength} — lets {@link RgbLedBody} paint a strip. */
  readonly moduleCount: number
  readonly oneFrame: number
  readonly zeroFrame: number
  readonly bitsPerSymbol: number
  readonly colorOrder: readonly Ws2812ColorId[]
  isChipEnabled(): boolean
  getPixelRgb(index: number): Rgbw
  getModuleRgb(index: number): Rgbw
  /** Brightest pixel — collapsed badge. */
  getRgb(): Rgbw
  version(): number
  subscribe(fn: () => void): () => void
}

export function isWs2812(chip: SpiChip | null | undefined): chip is Ws2812Chip {
  return (
    !!chip &&
    typeof (chip as Ws2812Chip).getPixelRgb === 'function' &&
    typeof (chip as Ws2812Chip).getModuleRgb === 'function' &&
    typeof (chip as Ws2812Chip).chainLength === 'number' &&
    (chip as Ws2812Chip).moduleCount === (chip as Ws2812Chip).chainLength
  )
}

export function createWs2812({
  cs = 0,
  name = 'WS2812 LED strip',
  chainLength = 16,
  oneFrame = 0x70,
  zeroFrame = 0x40,
  bitsPerSymbol = 8,
  colorOrder = ['g', 'r', 'b'],
}: Ws2812Options = {}): Ws2812Chip {
  const length = Math.max(1, chainLength | 0)
  const one = oneFrame & 0xff
  const zero = zeroFrame & 0xff
  const symbolBits = Math.min(8, Math.max(3, bitsPerSymbol | 0))
  const order = colorOrder.length > 0 ? [...colorOrder] : (['g', 'r', 'b'] as Ws2812ColorId[])
  const pixels = Array.from({ length }, () => ({ r: 0, g: 0, b: 0, w: 0 }))

  let generation = 0
  const listeners = new Set<() => void>()

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const getPixelRgb = (index: number): Rgbw => {
    if (index < 0 || index >= length) return { r: 0, g: 0, b: 0, w: 0 }
    const p = pixels[index]!
    return { r: p.r, g: p.g, b: p.b, w: p.w }
  }

  const getRgb = (): Rgbw => {
    let best = pixels[0]!
    let bestSum = best.r + best.g + best.b + best.w
    for (let i = 1; i < length; i++) {
      const p = pixels[i]!
      const sum = p.r + p.g + p.b + p.w
      if (sum > bestSum) {
        best = p
        bestSum = sum
      }
    }
    return { r: best.r, g: best.g, b: best.b, w: best.w }
  }

  /**
   * Decode one color channel from the SPI bitstream (MSB-first), matching
   * Zephyr's `ws2812_spi_ser` packing.
   */
  const decodeChannel = (
    tx: Uint8Array,
    offset: { byte: number; bitMask: number },
  ): number | null => {
    let value = 0
    for (let i = BITS_PER_CHANNEL - 1; i >= 0; i--) {
      let pattern = 0
      if (symbolBits === SPI_FRAME_BITS) {
        if (offset.byte >= tx.length) return null
        pattern = tx[offset.byte++]!
      } else {
        for (let p = symbolBits - 1; p >= 0; p--) {
          if (offset.byte >= tx.length) return null
          if (tx[offset.byte]! & offset.bitMask) pattern |= 1 << p
          offset.bitMask >>= 1
          if (!offset.bitMask) {
            offset.bitMask = 1 << (SPI_FRAME_BITS - 1)
            offset.byte++
          }
        }
      }
      if (pattern === one) value |= 1 << i
      // Anything else (zero frame or junk) is a '0' bit — silicon is
      // duty-cycle sensitive; we only need one/zero discrimination.
    }
    return value
  }

  return {
    cs,
    name,
    chainLength: length,
    moduleCount: length,
    oneFrame: one,
    zeroFrame: zero,
    bitsPerSymbol: symbolBits,
    colorOrder: order,
    isChipEnabled: () => true,
    getPixelRgb,
    getModuleRgb: getPixelRgb,
    getRgb,
    version: () => generation,
    transfer(tx: Uint8Array, _rx: Uint8Array, _opts: SpiTransferOpts) {
      // Empty write is not a strip update; reject so the guest sees TRANS_ERR.
      if (tx.length === 0) return false

      const offset = { byte: 0, bitMask: 1 << (SPI_FRAME_BITS - 1) }
      let changed = false
      let pixel = 0

      while (pixel < length) {
        const next = { r: 0, g: 0, b: 0, w: 0 }
        let incomplete = false
        for (const ch of order) {
          const value = decodeChannel(tx, offset)
          if (value === null) {
            incomplete = true
            break
          }
          next[ch] = value
        }
        if (incomplete) break

        const cur = pixels[pixel]!
        if (cur.r !== next.r || cur.g !== next.g || cur.b !== next.b || cur.w !== next.w) {
          pixels[pixel] = next
          changed = true
        }
        pixel++
      }

      // One notify per frame — do not churn React on every decoded byte.
      if (changed) notify()
      return true
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

export const ws2812Meta = {
  DEFAULT_CHAIN_LENGTH: 16,
  DEFAULT_ONE_FRAME: 0x70,
  DEFAULT_ZERO_FRAME: 0x40,
  DEFAULT_BITS_PER_SYMBOL: 8,
  DEFAULT_COLOR_ORDER: ['g', 'r', 'b'] as const,
  /** Bytes per RGB pixel when bits-per-symbol is 8. */
  bytesPerRgbPixel(bitsPerSymbol = 8): number {
    return (3 * BITS_PER_CHANNEL * bitsPerSymbol) / SPI_FRAME_BITS
  },
}
