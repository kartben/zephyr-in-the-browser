/** QEMU-wasm PtyBackend: load public/qemu artifacts and wire stdio to xterm-pty. */

import { attach as attachHostDisplay, detach as detachHostDisplay } from '@/hostDisplay'
import { attach as attachHostGnss, detach as detachHostGnss } from '@/hostGnss'
import { attach as attachHostGpio, detach as detachHostGpio } from '@/hostGpio'
import { attach as attachHostAudio, detach as detachHostAudio } from '@/hostAudio'
import { attach as attachHostMic, detach as detachHostMic } from '@/hostMic'
import { attach as attachGuestStats, detach as detachGuestStats } from '@/guestStats'
import { attach as attachHostNet, detach as detachHostNet } from '@/hostNet'
import { attach as attachHostInput, detach as detachHostInput } from '@/hostInput'
import { attach as attachHostTrace, detach as detachHostTrace } from '@/hostTrace'
import { attach as attachHostMonitor, detach as detachHostMonitor } from '@/hostMonitor'
import { attach as attachVirtio, detach as detachVirtio } from '@/virtio'
import { get as getGuestImage } from '@/guestImage'
import { loadSampleDts } from '@/devicetree'
import { MONITOR_ARGS, sampleAsset, sampleDtsAsset } from '@/boards'
import type { PtyBackend, Slave, StartOptions } from './types'

/**
 * Loads a prebuilt qemu-wasm artifact set from public/qemu/.
 *
 * Load order matters: create global `Module`, run file_packager `load.js` as a
 * classic script so it appends preRun hooks, then import the generated ES module.
 */

const ASSET_BASE = `${import.meta.env.BASE_URL}qemu/`

/** file_packager.py stub that fetches and mounts the .data blob at /pack/. */
const PACKAGE_SCRIPT = 'load.js'

// Irreversible once Module/load.js/pthread workers touch document-global state.
let documentTainted = false

interface QemuModule {
  arguments: string[]
  pty: Slave
  mainScriptUrlOrBlob: string
  locateFile: (path: string) => string
  printErr: (text: string) => void
  preRun: Array<() => void>
  onExit?: (code: number) => void
  onAbort?: (what: unknown) => void
  /** Exported via -sEXPORTED_RUNTIME_METHODS=...,TTY */
  TTY?: { stream_ops: { poll: (stream: unknown, timeout: unknown) => number } }
  /** file_packager uses these aliases, so .data-capable builds export them. */
  FS_createPath?: (parent: string, path: string, canRead: boolean, canWrite: boolean) => void
  FS_createDataFile?: (
    parent: string,
    name: string,
    data: Uint8Array,
    canRead: boolean,
    canWrite: boolean,
    canOwn: boolean,
  ) => void
}

declare global {
  // eslint-disable-next-line no-var
  var Module: QemuModule | undefined
}

const url = (file: string) => new URL(ASSET_BASE + file, location.href).href

function loadClassicScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.async = false
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(el)
  })
}

const NOT_BUILT_HINT = 'Run tools/build-qemu-wasm.sh — see public/qemu/README.md.'

// HTML at 200 is ambiguous: Vite serves the SPA for missing and newly-added public/ files.
const NOT_SERVED_HINT =
  'Either it has not been built (run tools/build-qemu-wasm.sh) or the dev server ' +
  'needs restarting — public/ is only indexed at startup.'

// Guest files must be written from preRun, after FS exists and before main().
function writeGuestFile(mod: QemuModule, fsPath: string, bytes: Uint8Array) {
  const { FS_createPath, FS_createDataFile } = mod
  if (!FS_createPath || !FS_createDataFile) {
    throw new Error(
      'This qemu-wasm build exports neither FS_createPath nor FS_createDataFile, ' +
        'so the guest image cannot be injected. Rebuild with -sFORCE_FILESYSTEM.',
    )
  }
  const parts = fsPath.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error(`invalid guest path: ${fsPath}`)
  if (parts.length) FS_createPath('/', parts.join('/'), true, true)
  FS_createDataFile(`/${parts.join('/')}`, name, bytes, true, true, true)
}

async function fetchAsset(file: string): Promise<Uint8Array> {
  const res = await fetch(url(file))
  if (!res.ok) {
    throw new Error(`${file} is missing from public/qemu/. ${NOT_BUILT_HINT}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

async function assertAsset(file: string) {
  let res: Response
  try {
    res = await fetch(url(file), { method: 'HEAD' })
  } catch (cause) {
    throw new Error(`Could not reach ${file}. ${NOT_BUILT_HINT}`, { cause })
  }
  if (!res.ok) {
    throw new Error(`${file} is missing from public/qemu/. ${NOT_BUILT_HINT}`)
  }
  // A 200 can still be the SPA index.html 404 fallback.
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/html')) {
    throw new Error(`${file} is not being served. ${NOT_SERVED_HINT}`)
  }
}

/**
 * Which optional bridges this emulator build has.
 *
 * Missing features.json means an old artifact with no optional bridges; do not
 * guess, because QEMU exits on unknown argv such as the monitor chardev.
 */
async function emulatorFeatures(): Promise<Set<string>> {
  try {
    const res = await fetch(url('features.json'))
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
      return new Set()
    }
    const json: unknown = await res.json()
    const list = (json as { features?: unknown })?.features
    return Array.isArray(list) ? new Set(list.filter((f): f is string => typeof f === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function createQemuBackend(): PtyBackend {
  return {
    id: 'qemu',
    label: 'QEMU',

    get resetRequiresReload() {
      return documentTainted
    },

    async start(slave: Slave, { board, sampleId, onStatus, signal }: StartOptions) {
      if (documentTainted) {
        throw new Error('QEMU is already instantiated in this tab. Reload to start a new session.')
      }

      // SharedArrayBuffer is required by xterm-pty and qemu-wasm PROXY_TO_PTHREAD.
      if (!globalThis.crossOriginIsolated) {
        throw new Error(
          'Page is not cross-origin isolated. Serve it with ' +
            'Cross-Origin-Opener-Policy: same-origin and ' +
            'Cross-Origin-Embedder-Policy: require-corp.',
        )
      }

      const mainScript = `${board.qemuBinary}.js`
      onStatus({ status: 'loading', detail: 'checking assets' })
      await assertAsset(mainScript)
      await assertAsset(`${board.qemuBinary}.wasm`)
      if (board.usesDataBundle) await assertAsset(PACKAGE_SCRIPT)
      if (signal.aborted) return

      // preRun cannot await, so fetch guest files before committing the document.
      const custom = getGuestImage()
      onStatus({
        status: 'loading',
        detail: custom ? `loading ${custom.name}` : `loading ${sampleId}`,
      })
      // DTS is optional for old image tarballs; absence just leaves panels on static tables.
      if (!custom) {
        void loadSampleDts(url(sampleDtsAsset(board, sampleId)), `${sampleId}.dts`)
      }
      const preloaded = [
        {
          fsPath: board.kernelFsPath,
          bytes: custom ? custom.bytes : await fetchAsset(sampleAsset(board, sampleId)),
        },
        ...(await Promise.all(
          (board.extraFiles ?? []).map(async (f) => ({
            fsPath: f.fsPath,
            bytes: await fetchAsset(f.asset),
          })),
        )),
      ]
      if (signal.aborted) return

      onStatus({ status: 'loading', detail: 'starting emulator' })

      // The monitor is build-gated, not board-gated.
      const features = await emulatorFeatures()
      const args = features.has('monitor') ? [...board.args, ...MONITOR_ARGS] : board.args

      const mod: QemuModule = {
        arguments: args,
        pty: slave,
        mainScriptUrlOrBlob: url(mainScript),
        locateFile: (path) => ASSET_BASE + path,
        printErr: (text) => console.error('[qemu]', text),
        // Runs after FS setup and before main(); load.js appends .data hooks here too.
        preRun: [
          () => {
            for (const { fsPath, bytes } of preloaded) writeGuestFile(mod, fsPath, bytes)
          },
        ],
        onExit: (code) =>
          onStatus({
            status: code === 0 ? 'exited' : 'error',
            detail: `exit code ${code}`,
          }),
        onAbort: (what) => onStatus({ status: 'error', detail: String(what) }),
      }

      documentTainted = true
      globalThis.Module = mod

      // Classic script sees global Module and appends file_packager preRun hooks.
      if (board.usesDataBundle) {
        await loadClassicScript(url(PACKAGE_SCRIPT))
        if (signal.aborted) return
      }

      // @vite-ignore: static asset in public/, fetched at runtime.
      const factory = (await import(/* @vite-ignore */ url(mainScript))) as {
        default: (m: QemuModule) => Promise<QemuModule>
      }
      if (signal.aborted) return

      onStatus({ status: 'loading', detail: 'booting' })
      const instance = await factory.default(mod)

      // Preserve receiver while applying qemu-wasm's TTY poll workaround.
      const tty = instance.TTY
      if (tty) {
        const oldPoll = tty.stream_ops.poll
        const pty = instance.pty
        tty.stream_ops.poll = function (this: unknown, stream: unknown, timeout: unknown) {
          if (!pty.readable) {
            return (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0)
          }
          return oldPoll.call(this, stream, timeout)
        }
      } else {
        console.warn(
          '[qemu] Module.TTY not exported; skipping poll patch. Build with ' +
            '-sEXPORTED_RUNTIME_METHODS=...,TTY,FS',
        )
      }

      // Virtio goes first: hostGpio binds to models that must exist before polling.
      if (board.peripherals?.virtio) attachVirtio(instance)
      else detachVirtio()
      if (board.peripherals?.ramfb) attachHostDisplay(instance)
      else detachHostDisplay()
      if (board.peripherals?.gnss) attachHostGnss(instance)
      else detachHostGnss()
      if (board.peripherals?.hostGpio) attachHostGpio(instance)
      else detachHostGpio()
      if (board.peripherals?.hostAudio) attachHostAudio(instance)
      else detachHostAudio()
      if (board.peripherals?.hostMic) attachHostMic(instance)
      else detachHostMic()
      if (board.peripherals?.perfStats) attachGuestStats(instance)
      else detachGuestStats()
      if (board.peripherals?.hostNet) attachHostNet(instance)
      else detachHostNet()
      if (board.peripherals?.hostInput) attachHostInput(instance)
      else detachHostInput()
      if (board.peripherals?.hostTrace) attachHostTrace(instance)
      else detachHostTrace()
      // Monitor is build-gated; attach() no-ops when exports are missing.
      attachHostMonitor(instance)

      onStatus({ status: 'running', detail: custom ? custom.name : sampleId })
    },

    async reset() {
      detachVirtio()
      detachHostDisplay()
      detachHostGnss()
      detachHostGpio()
      detachHostAudio()
      detachHostMic()
      detachGuestStats()
      detachHostNet()
      detachHostInput()
      detachHostTrace()
      detachHostMonitor()
      if (!documentTainted) return
      // Emscripten modules cannot be torn down cleanly; reset reloads the document.
      location.reload()
      await new Promise<never>(() => {})
    },
  }
}
