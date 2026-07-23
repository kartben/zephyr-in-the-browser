/**
 * ramfb frame renderers, shared by the main thread and the OffscreenCanvas
 * render worker. Nothing here touches the DOM beyond the canvas it is handed,
 * so the same code runs against an HTMLCanvasElement or an OffscreenCanvas.
 */

/** How a frame reached the GPU, surfaced for diagnostics (see DisplayPanel). */
export type UploadMode = 'direct' | 'copy' | 'pixel-conversion'

export interface RendererOptions {
  /**
   * Reports how frames are being uploaded. Fires once the mode is settled: on
   * the first WebGL upload, or immediately for the Canvas 2D path. The main
   * thread mirrors it onto the host canvas' dataset; the worker forwards it.
   */
  onUploadMode?: (mode: UploadMode) => void
}

export interface FrameRenderer {
  draw(source: Uint8Array): void
  dispose(): void
}

/** A canvas the WebGL path can render into, on either thread. */
type WebGLCanvas = HTMLCanvasElement | OffscreenCanvas

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
export function createWebGLRenderer(
  canvas: WebGLCanvas,
  width: number,
  height: number,
  stride: number,
  options?: RendererOptions,
): FrameRenderer {
  if (stride % 4 !== 0) throw new Error(`WebGL cannot represent ramfb stride ${stride}`)

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null
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
          options?.onUploadMode?.('direct')
        } catch {
          uploadCopy = new Uint8Array(source.length)
          uploadCopy.set(source)
          upload(uploadCopy)
          uploadMode = 'copy'
          options?.onUploadMode?.('copy')
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

export function createCanvasRenderer(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  stride: number,
  options?: RendererOptions,
): FrameRenderer {
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Canvas 2D is unavailable')
  const image = context.createImageData(width, height)
  options?.onUploadMode?.('pixel-conversion')

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
