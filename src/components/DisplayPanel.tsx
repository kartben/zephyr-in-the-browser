import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Monitor, Pointer } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { cn } from '@/lib/utils'
import { getFrame, getFrameSequence, getSharedBuffer, getSnapshot, subscribe } from '@/hostDisplay'
import {
  available as pointerAvailable,
  movePointer,
  releaseButtons,
  scroll,
  setButtons,
} from '@/hostInput'
import {
  createCanvasRenderer,
  createWebGLRenderer,
  type FrameRenderer,
  type UploadMode,
} from '@/display/renderers'
import type { MainToWorker, WorkerToMain } from '@/display/renderWorker'
import { profile, recordWorkerFrame, setRenderWorker } from '@/display/profile'

/**
 * Each strategy keys a fresh <canvas>: transferControlToOffscreen and
 * getContext are one-shot per element.
 */
type RenderStrategy = 'worker-webgl' | 'main-webgl' | 'main-canvas2d'

// Main-thread renderers share time with xterm and React; the worker path does not.
const FRAME_INTERVAL_MS = 1000 / 30

/**
 * object-contain letterboxes the image; pointer events need framebuffer coords,
 * not element coords. Values outside 0..1 are left for hostInput to clamp.
 */
function framebufferPoint(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
  width: number,
  height: number,
) {
  const rect = canvas.getBoundingClientRect()
  if (!rect.width || !rect.height || !width || !height) return null
  const scale = Math.min(rect.width / width, rect.height / height)
  const drawnWidth = width * scale
  const drawnHeight = height * scale
  return {
    nx: (event.clientX - rect.left - (rect.width - drawnWidth) / 2) / drawnWidth,
    ny: (event.clientY - rect.top - (rect.height - drawnHeight) / 2) / drawnHeight,
  }
}

function workerRenderingSupported(buffer: ArrayBufferLike | null): buffer is SharedArrayBuffer {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype &&
    typeof SharedArrayBuffer !== 'undefined' &&
    buffer instanceof SharedArrayBuffer
  )
}

export function DisplayPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const display = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // Header state lives outside the collapsible body.
  const [pointer, setPointer] = useState(false)

  useEffect(() => {
    setPointer(display.available && pointerAvailable())
  }, [display.available])

  if (!display.available) return null

  return (
    <PanelFrame
      id="display"
      title="Display"
      icon={Monitor}
      defaultExpanded={defaultExpanded}
      dockedWidth={42}
      status={
        <>
          <span className="font-mono text-[11px] text-muted-foreground">
            {display.width}×{display.height}
          </span>
          {pointer && (
            <span
              role="img"
              aria-label="Touch input enabled"
              title="Click and drag on the display — it is a virtio-input tablet"
            >
              <Pointer className="size-3 text-muted-foreground" aria-hidden />
            </span>
          )}
        </>
      }
    >
      <DisplayBody display={display} pointer={pointer} />
    </PanelFrame>
  )
}

function DisplayBody({
  display,
  pointer,
}: {
  display: ReturnType<typeof getSnapshot>
  pointer: boolean
}) {
  const [strategy, setStrategy] = useState<RenderStrategy>('worker-webgl')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // StrictMode replays setup on the same one-shot transferred canvas; defer
  // teardown so the second setup can reclaim the worker session.
  const sessionRef = useRef<{
    el: HTMLCanvasElement
    worker: Worker
    unsubscribe: () => void
  } | null>(null)
  const teardownRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (strategy !== 'worker-webgl') return

    const destroy = () => {
      const session = sessionRef.current
      if (!session) return
      session.unsubscribe()
      const stop: MainToWorker = { type: 'stop' }
      session.worker.postMessage(stop)
      session.worker.terminate()
      sessionRef.current = null
    }
    // Identity check prevents a deferred cleanup from killing a newer session.
    const scheduleDestroy = () => {
      const session = sessionRef.current
      teardownRef.current = setTimeout(() => {
        teardownRef.current = undefined
        if (sessionRef.current === session) destroy()
      }, 0)
    }
    const cancelPendingDestroy = () => {
      if (teardownRef.current === undefined) return
      clearTimeout(teardownRef.current)
      teardownRef.current = undefined
    }

    const canvas = canvasRef.current
    const shouldRender = display.available && !!canvas

    // StrictMode re-running setup on the same element: keep the transferred canvas.
    if (shouldRender && sessionRef.current?.el === canvas) {
      cancelPendingDestroy()
      setRenderWorker(sessionRef.current.worker)
      return () => {
        setRenderWorker(null)
        scheduleDestroy()
      }
    }

    cancelPendingDestroy()
    destroy()
    if (!shouldRender) return

    const buffer = getSharedBuffer()
    if (!workerRenderingSupported(buffer)) {
      setStrategy('main-webgl')
      return
    }

    const snap = getSnapshot()
    let worker: Worker
    let offscreen: OffscreenCanvas
    try {
      // Size before transfer so OffscreenCanvas avoids the 300x150 default.
      canvas.width = snap.width
      canvas.height = snap.height
      offscreen = canvas.transferControlToOffscreen()
      worker = new Worker(new URL('../display/renderWorker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      setStrategy('main-webgl')
      return
    }

    const fallBack = () => {
      destroy()
      setStrategy('main-webgl')
    }
    worker.onerror = () => fallBack()
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const message = event.data
      if (message.type === 'ready') canvas.dataset.renderer = 'worker-webgl2'
      else if (message.type === 'uploadMode') canvas.dataset.frameUpload = message.mode
      else if (message.type === 'frameStats') recordWorkerFrame(message)
      else if (message.type === 'fatal') fallBack()
    }

    const init: MainToWorker = {
      type: 'init',
      canvas: offscreen,
      buffer,
      snapshot: { ...snap },
    }
    worker.postMessage(init, [offscreen])
    if (profile.enabled) {
      const enableMsg: MainToWorker = { type: 'profile', enabled: true }
      worker.postMessage(enableMsg)
    }
    setRenderWorker(worker)

    // Forward ramfb metadata changes without repeating the one-shot transfer.
    const unsubscribe = subscribe(() => {
      const next = getSnapshot()
      const nextBuffer = getSharedBuffer()
      if (!next.available || !nextBuffer) return
      const update: MainToWorker = { type: 'update', buffer: nextBuffer, snapshot: { ...next } }
      worker.postMessage(update)
    })

    sessionRef.current = { el: canvas, worker, unsubscribe }
    return () => {
      setRenderWorker(null)
      scheduleDestroy()
    }
  }, [strategy, display.available])

  // Fallback path: main-thread WebGL, then Canvas 2D.
  useEffect(() => {
    if (strategy === 'worker-webgl') return
    const canvas = canvasRef.current
    if (!display.available || !canvas) return

    canvas.width = display.width
    canvas.height = display.height
    const onUploadMode = (mode: UploadMode) => {
      canvas.dataset.frameUpload = mode
    }
    let renderer: FrameRenderer
    if (strategy === 'main-webgl') {
      try {
        renderer = createWebGLRenderer(canvas, display.width, display.height, display.stride, {
          onUploadMode,
        })
        canvas.dataset.renderer = 'webgl2'
      } catch {
        // A canvas cannot switch context type after getContext('webgl2').
        setStrategy('main-canvas2d')
        return
      }
    } else {
      renderer = createCanvasRenderer(canvas, display.width, display.height, display.stride, {
        onUploadMode,
      })
      canvas.dataset.renderer = 'canvas2d'
    }

    let stopped = false
    let previous = 0
    let lastFrameSequence: number | null = null
    let animationFrame = 0
    const draw = (now: number) => {
      if (stopped) return
      if (now - previous >= FRAME_INTERVAL_MS) {
        const sequence = getFrameSequence()
        if (sequence === null || sequence !== lastFrameSequence) {
          const source = getFrame()
          if (source) renderer.draw(source)
          lastFrameSequence = sequence
        }
        previous = now
      }
      animationFrame = requestAnimationFrame(draw)
    }
    animationFrame = requestAnimationFrame(draw)
    return () => {
      stopped = true
      cancelAnimationFrame(animationFrame)
      renderer.dispose()
    }
  }, [strategy, display])

  // Input is likely to repaint the guest; wake before the idle worker tick.
  const wakeRenderWorker = () => {
    const worker = sessionRef.current?.worker
    if (!worker) return
    const wake: MainToWorker = { type: 'wake' }
    worker.postMessage(wake)
  }

  // Pointer capture keeps drags alive past the canvas edge.
  const pointerHandlers = pointer
    ? {
        onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => {
          // hostInput drops hover on its own; skip the layout read.
          if (!event.buttons) return
          const point = framebufferPoint(event.currentTarget, event, display.width, display.height)
          if (point) movePointer(point.nx, point.ny)
        },
        onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          const point = framebufferPoint(event.currentTarget, event, display.width, display.height)
          if (point) setButtons(point.nx, point.ny, event.buttons)
          wakeRenderWorker()
        },
        onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => {
          const point = framebufferPoint(event.currentTarget, event, display.width, display.height)
          if (point) setButtons(point.nx, point.ny, event.buttons)
        },
        onPointerCancel: () => releaseButtons(),
        onPointerLeave: () => releaseButtons(),
        onWheel: (event: React.WheelEvent<HTMLCanvasElement>) => {
          scroll(event.deltaY)
          wakeRenderWorker()
        },
        // Let secondary clicks reach the guest.
        onContextMenu: (event: React.MouseEvent<HTMLCanvasElement>) => event.preventDefault(),
      }
    : {}

  return (
    <div className="bg-black p-2">
      <canvas
        key={strategy}
        ref={canvasRef}
        className={cn(
          'mx-auto block max-h-[min(70vh,48rem)] w-full object-contain [image-rendering:auto]',
          // Keep touch drags routed to the guest, not page scroll.
          pointer && 'cursor-crosshair touch-none',
        )}
        style={{ aspectRatio: `${display.width} / ${display.height}` }}
        aria-label={`Guest display, ${display.width} by ${display.height} pixels${
          pointer ? ', accepts touch input' : ''
        }`}
        {...pointerHandlers}
      />
    </div>
  )
}
