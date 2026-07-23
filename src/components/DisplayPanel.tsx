import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Monitor, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getFrame, getSharedBuffer, getSnapshot, subscribe } from '@/hostDisplay'
import {
  createCanvasRenderer,
  createWebGLRenderer,
  type FrameRenderer,
  type UploadMode,
} from '@/display/renderers'
import type { MainToWorker, WorkerToMain } from '@/display/renderWorker'

/**
 * How the framebuffer reaches the canvas, in order of preference:
 *  - `worker-webgl`: an OffscreenCanvas painted by a dedicated worker, so the
 *    texture upload never touches the UI/terminal thread.
 *  - `main-webgl`: the same WebGL path on the main thread (no OffscreenCanvas,
 *    or the worker failed to get a context).
 *  - `main-canvas2d`: per-pixel Canvas 2D, the last resort.
 * Each strategy keys a fresh <canvas>: transferControlToOffscreen and
 * getContext are both one-shot per element, so a fallback needs a new one.
 */
type RenderStrategy = 'worker-webgl' | 'main-webgl' | 'main-canvas2d'

const FRAME_INTERVAL_MS = 1000 / 30

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

/** Paints Zephyr's qemu,ramfb framebuffer into a browser canvas. */
export function DisplayPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const display = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)
  const [strategy, setStrategy] = useState<RenderStrategy>('worker-webgl')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The live worker render session, kept in a ref so it survives StrictMode's
  // setup→cleanup→setup double-invoke. transferControlToOffscreen() is one-shot
  // per <canvas>, so the session is built once per element and its teardown is
  // deferred, letting the immediate re-setup reclaim it instead of re-transferring.
  const sessionRef = useRef<{
    el: HTMLCanvasElement
    worker: Worker
    unsubscribe: () => void
  } | null>(null)
  const teardownRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Preferred path: hand a transferred OffscreenCanvas and the shared heap to a
  // worker, which reads the framebuffer and uploads it on its own thread. Only
  // display.available gates setup — resolution or pointer changes are pushed as
  // `update` messages so the one-shot canvas transfer is never repeated.
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
    // Deferred so StrictMode's synchronous re-setup can cancel it; the identity
    // check stops it felling a session a later setup already replaced.
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
    const shouldRender = display.available && !collapsed && !dismissed && !!canvas

    // StrictMode re-running setup on the still-lit element: keep the worker and
    // cancel the teardown the paired cleanup just scheduled.
    if (shouldRender && sessionRef.current?.el === canvas) {
      cancelPendingDestroy()
      return scheduleDestroy
    }

    // Any real transition (first mount, collapse, a fresh element) drops the
    // previous session up front, then decides whether to build a new one.
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
      // Size the host element before transfer so the OffscreenCanvas inherits
      // the guest resolution instead of the 300x150 default.
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
      else if (message.type === 'fatal') fallBack()
    }

    const init: MainToWorker = {
      type: 'init',
      canvas: offscreen,
      buffer,
      snapshot: { ...snap },
      frameIntervalMs: FRAME_INTERVAL_MS,
    }
    worker.postMessage(init, [offscreen])

    // The guest reconfigures ramfb rarely; forward each change without tearing
    // the worker down. getFrame() is unused here — the worker owns the read.
    const unsubscribe = subscribe(() => {
      const next = getSnapshot()
      const nextBuffer = getSharedBuffer()
      if (!next.available || !nextBuffer) return
      const update: MainToWorker = { type: 'update', buffer: nextBuffer, snapshot: { ...next } }
      worker.postMessage(update)
    })

    sessionRef.current = { el: canvas, worker, unsubscribe }
    return scheduleDestroy
  }, [strategy, collapsed, dismissed, display.available])

  // Fallback path: render on the main thread. Reached only when the worker or
  // OffscreenCanvas is unavailable. Keeps the WebGL-then-Canvas2D degradation.
  useEffect(() => {
    if (strategy === 'worker-webgl') return
    const canvas = canvasRef.current
    if (!display.available || collapsed || dismissed || !canvas) return

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
        // A canvas cannot switch context type after getContext('webgl2'); the
        // strategy key below mounts a fresh element for Canvas 2D.
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
    let animationFrame = 0
    const draw = (now: number) => {
      if (stopped) return
      if (now - previous >= FRAME_INTERVAL_MS) {
        const source = getFrame()
        if (source) renderer.draw(source)
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
  }, [strategy, collapsed, dismissed, display])

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
            key={strategy}
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
