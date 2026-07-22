import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, Monitor, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getFrame, getSnapshot, subscribe } from '@/hostDisplay'

interface FrameRenderer {
  draw(source: Uint8Array): void
  dispose(): void
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Could not create WebGL shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compilation error'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

/** Uploads BGRA ramfb bytes directly and swaps red/blue in a fragment shader. */
function createWebGLRenderer(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  stride: number,
): FrameRenderer {
  if (stride % 4 !== 0) throw new Error(`WebGL cannot represent ramfb stride ${stride}`)

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  })
  if (!gl) throw new Error('WebGL 2 is unavailable')

  const vertex = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `#version 300 es
      const vec2 positions[4] = vec2[4](
        vec2(-1.0, -1.0), vec2(1.0, -1.0),
        vec2(-1.0,  1.0), vec2(1.0,  1.0)
      );
      const vec2 coordinates[4] = vec2[4](
        vec2(0.0, 1.0), vec2(1.0, 1.0),
        vec2(0.0, 0.0), vec2(1.0, 0.0)
      );
      out vec2 textureCoordinate;
      void main() {
        gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
        textureCoordinate = coordinates[gl_VertexID];
      }
    `,
  )
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `#version 300 es
      precision lowp float;
      uniform sampler2D framebuffer;
      in vec2 textureCoordinate;
      out vec4 outputColor;
      void main() {
        vec4 bgra = texture(framebuffer, textureCoordinate);
        outputColor = bgra.bgra;
      }
    `,
  )
  const program = gl.createProgram()
  if (!program) throw new Error('Could not create WebGL program')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'Unknown WebGL link error'
    gl.deleteProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error(message)
  }

  const texture = gl.createTexture()
  if (!texture) throw new Error('Could not create WebGL texture')
  gl.viewport(0, 0, width, height)
  gl.disable(gl.BLEND)
  gl.disable(gl.DEPTH_TEST)
  gl.useProgram(program)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.uniform1i(gl.getUniformLocation(program, 'framebuffer'), 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / 4)

  let uploadMode: 'unknown' | 'direct' | 'copy' = 'unknown'
  let uploadCopy: Uint8Array | null = null

  const upload = (pixels: Uint8Array) => {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  }

  return {
    draw(source) {
      // Emscripten pthread heaps use SharedArrayBuffer. Most browsers accept a
      // view of it directly; retain a native bulk-copy fallback for those that
      // reject shared views as WebGL texture sources.
      if (uploadMode === 'copy') {
        uploadCopy!.set(source)
        upload(uploadCopy!)
      } else if (uploadMode === 'direct') {
        upload(source)
      } else {
        try {
          upload(source)
          if (gl.getError() !== gl.NO_ERROR) throw new Error('Direct texture upload failed')
          uploadMode = 'direct'
          canvas.dataset.frameUpload = 'direct'
        } catch {
          uploadCopy = new Uint8Array(source.length)
          uploadCopy.set(source)
          upload(uploadCopy)
          uploadMode = 'copy'
          canvas.dataset.frameUpload = 'copy'
        }
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose() {
      gl.deleteTexture(texture)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    },
  }
}

function createCanvasRenderer(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  stride: number,
): FrameRenderer {
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Canvas 2D is unavailable')
  const image = context.createImageData(width, height)
  canvas.dataset.frameUpload = 'pixel-conversion'

  return {
    draw(source) {
      const target = image.data
      for (let y = 0; y < height; y += 1) {
        let src = y * stride
        let dst = y * width * 4
        const end = dst + width * 4
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
    },
    dispose() {},
  }
}

/** Paints Zephyr's qemu,ramfb framebuffer into a browser canvas. */
export function DisplayPanel() {
  const display = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [rendererKind, setRendererKind] = useState<'webgl2' | 'canvas2d'>('webgl2')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!display.available || collapsed || dismissed || !canvas) return

    canvas.width = display.width
    canvas.height = display.height
    let renderer: FrameRenderer
    if (rendererKind === 'webgl2') {
      try {
        renderer = createWebGLRenderer(canvas, display.width, display.height, display.stride)
        canvas.dataset.renderer = 'webgl2'
      } catch {
        // Changing the key below gives Canvas 2D a fresh element; a canvas
        // cannot switch context type after getContext('webgl2') succeeds.
        setRendererKind('canvas2d')
        return
      }
    } else {
      renderer = createCanvasRenderer(canvas, display.width, display.height, display.stride)
      canvas.dataset.renderer = 'canvas2d'
    }
    let stopped = false
    let previous = 0
    let animationFrame = 0

    const draw = (now: number) => {
      if (stopped) return
      // WebGL uploads the shared framebuffer without a per-pixel JavaScript
      // conversion, so a fluid refresh rate no longer starves the terminal/UI.
      if (now - previous >= 1000 / 30) {
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
  }, [collapsed, dismissed, display, rendererKind])

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
            key={rendererKind}
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
