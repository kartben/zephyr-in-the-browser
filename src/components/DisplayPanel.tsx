import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Monitor, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getFrame, getSnapshot, subscribe } from '@/hostDisplay'

/** Paints Zephyr's qemu,ramfb framebuffer into a browser canvas. */
export function DisplayPanel() {
  const display = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!display.available || collapsed || dismissed || !canvas) return

    canvas.width = display.width
    canvas.height = display.height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return
    const image = context.createImageData(display.width, display.height)
    let stopped = false
    let previous = 0
    let animationFrame = 0

    const draw = (now: number) => {
      if (stopped) return
      // Scanning and color-converting the framebuffer is substantial; 12 fps
      // is enough for Zephyr samples without starving the terminal/UI thread.
      if (now - previous >= 1000 / 12) {
        const source = getFrame()
        if (source) {
          const target = image.data
          for (let y = 0; y < display.height; y += 1) {
            let src = y * display.stride
            let dst = y * display.width * 4
            const end = dst + display.width * 4
            // DRM AR24 is BGRA byte order on this little-endian guest; Canvas
            // ImageData wants RGBA.
            while (dst < end) {
              target[dst] = source[src + 2]
              target[dst + 1] = source[src + 1]
              target[dst + 2] = source[src]
              target[dst + 3] = 0xff
              src += 4
              dst += 4
            }
          }
          context.putImageData(image, 0, 0)
        }
        previous = now
      }
      animationFrame = requestAnimationFrame(draw)
    }

    animationFrame = requestAnimationFrame(draw)
    return () => {
      stopped = true
      cancelAnimationFrame(animationFrame)
    }
  }, [collapsed, dismissed, display])

  if (!display.available || dismissed) return null

  return (
    <div className="pointer-events-auto w-[42rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          !collapsed && 'border-b border-border',
        )}
      >
        <Monitor className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">Display</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {display.width}×{display.height}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? 'Expand display' : 'Collapse display'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide display panel"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="bg-black p-2">
          <canvas
            ref={canvasRef}
            className="mx-auto block max-h-[min(70vh,48rem)] w-full object-contain [image-rendering:auto]"
            style={{ aspectRatio: `${display.width} / ${display.height}` }}
            aria-label={`Guest display, ${display.width} by ${display.height} pixels`}
          />
        </div>
      )}
    </div>
  )
}
