import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, MonitorDot, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isBound, ssd1306, subscribeBinds } from '@/virtio'

/**
 * The browser's SSD1306 OLED, painted from the chip's GDDRAM.
 *
 * There is no framebuffer to map here and nothing exported from QEMU: the
 * pixels are an array in src/virtio/devices/chips/ssd1306.ts that Zephyr's
 * stock driver filled in over I2C, so this panel reads the device's own memory
 * directly. That is the difference between this and the ramfb display panel,
 * which renders a buffer the guest owns.
 *
 * Repainting is driven by the chip's version counter rather than a timer: the
 * guest writes a frame in nine I2C transfers and each one bumps it, so a redraw
 * per notification would paint eight partial frames for every whole one. A
 * requestAnimationFrame coalesces them, which also caps the work at the
 * display's refresh rate no matter how fast the guest draws.
 */
const SCALE = 2

export function OledPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const isAvailable = useSyncExternalStore(
    subscribeBinds,
    useCallback(() => isBound('i2c'), []),
    () => false,
  )
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const visible = isAvailable && !dismissed && !collapsed

  useEffect(() => {
    if (!visible) return
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
  }, [visible])

  if (!isAvailable || dismissed) return null

  return (
    <div className="pointer-events-auto w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          !collapsed && 'border-b border-border',
        )}
      >
        <MonitorDot className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">OLED</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {ssd1306.width}x{ssd1306.height} · 0x{ssd1306.address.toString(16)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? 'Expand OLED panel' : 'Collapse OLED panel'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide OLED panel"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="space-y-2 px-3 py-3">
          <canvas
            ref={canvasRef}
            width={ssd1306.width}
            height={ssd1306.height}
            aria-label="SSD1306 OLED contents"
            className="w-full rounded border border-border bg-black"
            style={{
              // Nearest-neighbour: this is a 128x64 panel blown up, and
              // smoothing it would only make the pixels look like a mistake.
              imageRendering: 'pixelated',
              aspectRatio: `${ssd1306.width} / ${ssd1306.height}`,
              maxWidth: ssd1306.width * SCALE,
            }}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Zephyr&apos;s stock{' '}
            <code className="font-mono text-foreground">solomon,ssd1306-i2c</code> driver,
            drawing over the browser&apos;s I2C bus — nine transfers per full frame.
          </p>
        </div>
      )}
    </div>
  )
}
