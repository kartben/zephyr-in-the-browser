/**
 * Lazy Bumble virtual controller under Pyodide.
 *
 * Vendoring and pin details: public/vendor/bumble/README.md
 * (wheel) and the Pyodide CDN pin in {@link PYODIDE_INDEX_URL}.
 */

export interface BtControllerHandle {
  name: string
  /** Deliver one complete H:4 HCI packet (with type byte) from the Zephyr host. */
  onHostPacket: (packet: Uint8Array) => void
  close: () => void
}

export interface EnsureControllerOpts {
  /** Controller → Zephyr host: full HCI packet including type byte. */
  onHostPacket: (packet: Uint8Array) => void
}

/** Pinned Pyodide release. Override at build time with VITE_PYODIDE_INDEX_URL. */
export const PYODIDE_INDEX_URL =
  (import.meta.env.VITE_PYODIDE_INDEX_URL as string | undefined) ??
  'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/'

/** Served from public/; produced by tools/vendor-bumble.sh. */
export const BUMBLE_WHEEL_URL = `${import.meta.env.BASE_URL}vendor/bumble/bumble-0.0.233-py3-none-any.whl`

const CONTROLLER_PY = `
import asyncio
from bumble.controller import Controller
from bumble.link import LocalLink

class _JsSink:
    def __init__(self, send):
        self._send = send
    def on_packet(self, packet):
        # packet is already bytes with the HCI type prefix
        self._send(packet)

link = LocalLink()
_sink = _JsSink(js_send_to_host)
controller = Controller('zephyr-browser', host_sink=_sink, link=link)

def on_host_packet(data):
    # data: memoryview / bytes from JS
    controller.on_packet(bytes(data))

def close():
    pass
`

type PyodideInterface = {
  loadPackage: (names: string | string[]) => Promise<void>
  runPythonAsync: (code: string) => Promise<unknown>
  globals: { set: (k: string, v: unknown) => void; get: (k: string) => unknown }
  pyimport: (name: string) => {
    install: (url: string | string[]) => Promise<void>
  }
}

let pyodidePromise: Promise<PyodideInterface> | null = null
let handle: BtControllerHandle | null = null

async function loadPyodide(): Promise<PyodideInterface> {
  if (pyodidePromise) return pyodidePromise
  pyodidePromise = (async () => {
    // Official loader attaches loadPyodide on globalThis. Load via <script>
    // rather than import() — Vite cannot resolve the CDN ESM entry as a chunk.
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-pyodide]')
      if (existing) {
        if ((globalThis as { loadPyodide?: unknown }).loadPyodide) {
          resolve()
          return
        }
        existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener('error', () => reject(new Error('pyodide.js failed')), {
          once: true,
        })
        return
      }
      const script = document.createElement('script')
      script.src = `${PYODIDE_INDEX_URL}pyodide.js`
      script.async = true
      script.dataset.pyodide = '1'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error(`failed to load ${script.src}`))
      document.head.appendChild(script)
    })
    const loader = (globalThis as unknown as {
      loadPyodide: (opts: { indexURL: string }) => Promise<PyodideInterface>
    }).loadPyodide
    if (typeof loader !== 'function') {
      throw new Error('loadPyodide missing after loading pyodide.js')
    }
    const pyodide = await loader({ indexURL: PYODIDE_INDEX_URL })
    // cryptography (Emscripten build) + pyee are Bumble's hard deps in-browser.
    await pyodide.loadPackage(['micropip'])
    const micropip = pyodide.pyimport('micropip')
    await micropip.install(['pyee'])
    try {
      await pyodide.loadPackage(['cryptography'])
    } catch {
      await micropip.install(['cryptography'])
    }
    await micropip.install([BUMBLE_WHEEL_URL])
    return pyodide
  })()
  return pyodidePromise
}

export async function ensureController(opts: EnsureControllerOpts): Promise<BtControllerHandle> {
  if (handle) return handle
  const pyodide = await loadPyodide()

  const sendToHost = (packet: ArrayBuffer | Uint8Array | { toJs?: () => Uint8Array }) => {
    let bytes: Uint8Array
    if (packet instanceof Uint8Array) bytes = packet
    else if (packet instanceof ArrayBuffer) bytes = new Uint8Array(packet)
    else if (packet && typeof packet.toJs === 'function') bytes = packet.toJs()
    else bytes = new Uint8Array(packet as ArrayBuffer)
    opts.onHostPacket(bytes)
  }

  pyodide.globals.set('js_send_to_host', sendToHost)
  await pyodide.runPythonAsync(CONTROLLER_PY)

  const onHostPacketPy = pyodide.globals.get('on_host_packet') as (data: Uint8Array) => void
  const closePy = pyodide.globals.get('close') as () => void

  handle = {
    name: 'zephyr-browser',
    onHostPacket: (packet) => {
      onHostPacketPy(packet)
    },
    close: () => {
      try {
        closePy()
      } catch {
        /* ignore */
      }
      handle = null
    },
  }
  return handle
}

/** Test helper: drop the cached handle so the next ensure reloads. */
export function resetControllerForTests() {
  handle?.close()
  handle = null
}
