import { useEffect, useRef } from 'react'
import { OledControllerButton } from '@/components/OledController'
import { ssd1306 } from '@/virtio'

/**
 * The browser's SSD1306 OLED, painted from the chip's GDDRAM.
 *
 * There is no framebuffer to map here and nothing exported from QEMU: the
 * pixels are an array in src/virtio/devices/chips/ssd1306.ts that Zephyr's
 * stock driver filled in over I2C, so this panel reads the device's own memory
 * directly. That is the difference between this and the ramfb display panel,
 * which renders a buffer the guest owns.
 */
/**
 * Split out so the canvas and its subscription mount and unmount with the
 * panel body — PanelFrame renders children only while expanded, so a collapsed
 * panel costs nothing rather than repainting into a hidden canvas. Same reason
 * DisplayPanel has a DisplayBody. Exported for the dock, whose SSD1306 row
 * mounts the same canvas; a remount repaints in full from GDDRAM.
 *
 * Repainting is driven by the chip's version counter through a
 * requestAnimationFrame, not by the notification itself: the guest writes a
 * frame in nine I2C transfers and each one bumps the counter, so painting per
 * notification would draw eight partial frames for every whole one. Coalescing
 * also caps the work at the display refresh rate however fast the guest draws.
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
      // Coalesce a frame's worth of chunked writes into one repaint.
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
          // Nearest-neighbour: this is a 128x64 panel blown up, and smoothing
          // it would only make the pixels look like a mistake.
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
