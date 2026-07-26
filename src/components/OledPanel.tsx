/** Dock body for the SSD1306 OLED framebuffer. */

import { useEffect, useRef } from 'react'
import { OledControllerButton } from '@/components/OledController'
import { ssd1306 } from '@/virtio'

/**
 * SSD1306 has no QEMU ramfb; paint directly from the browser-side GDDRAM that
 * Zephyr's stock driver filled over I2C.
 */
export function OledBody() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height, memory } = ssd1306
    const image = ctx.createImageData(width, height)
    let frame = 0
    let painted = -1

    const paint = () => {
      frame = 0
      const version = ssd1306.version()
      if (version === painted) return
      painted = version

      const on = ssd1306.isOn()
      const invert = ssd1306.isInverted()
      const data = image.data
      for (let y = 0; y < height; y++) {
        const page = y >> 3
        const bit = 1 << (y & 7)
        for (let x = 0; x < width; x++) {
          let lit = on && (memory[page * width + x] & bit) !== 0
          if (invert) lit = on && !lit
          const i = (y * width + x) * 4
          // An OLED's off pixel is genuinely black, and its on pixel on these
          // parts is a slightly blue-tinted white.
          data[i] = lit ? 0xe6 : 0x0a
          data[i + 1] = lit ? 0xf2 : 0x0a
          data[i + 2] = lit ? 0xff : 0x0f
          data[i + 3] = 0xff
        }
      }
      ctx.putImageData(image, 0, 0)
    }

    const schedule = () => {
      // Coalesce chunked I2C writes into one repaint.
      if (!frame) frame = requestAnimationFrame(paint)
    }

    paint()
    const unsubscribe = ssd1306.subscribe(schedule)
    return () => {
      unsubscribe()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div className="space-y-2 px-3 py-3">
      <canvas
        ref={canvasRef}
        width={ssd1306.width}
        height={ssd1306.height}
        aria-label="SSD1306 OLED contents"
        className="w-full rounded border border-border bg-black"
        style={{
          // This is a 128x64 panel blown up; smoothing looks wrong.
          imageRendering: 'pixelated',
          aspectRatio: `${ssd1306.width} / ${ssd1306.height}`,
        }}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Zephyr&apos;s stock{' '}
        <code className="font-mono text-foreground">solomon,ssd1306-i2c</code> driver,
        drawing over the browser&apos;s I2C bus — nine transfers per full frame.
      </p>
      <OledControllerButton chip={ssd1306} />
    </div>
  )
}
