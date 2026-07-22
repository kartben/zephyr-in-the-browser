import { attach as attachHostSensor, detach as detachHostSensor } from '@/hostSensor'
import { attach as attachHostDisplay, detach as detachHostDisplay } from '@/hostDisplay'
import { attach as attachHostGnss, detach as detachHostGnss } from '@/hostGnss'
import { get as getGuestImage } from '@/guestImage'
import { sampleAsset } from '@/boards'
import type { PtyBackend, Slave, StartOptions } from './types'

/**
 * Loads a prebuilt qemu-wasm Emscripten artifact set out of public/qemu/ and
 * hands its stdio to the xterm-pty slave.
 *
 * The loading sequence mirrors ktock/qemu-wasm's own example page
 * (examples/riscv64/src/htdocs/index.html on the `master` branch): a global
 * `Module` is populated first, the file_packager stub `load.js` is pulled in as
 * a *classic* script so it can register its preRun hooks onto that global, and
 * only then is the board's generated ES-module imported and invoked.
 *
 * Nothing here is built in this repo — see public/qemu/README.md for the drop-in
 * contract and how to produce the artifacts.
 */

const ASSET_BASE = `${import.meta.env.BASE_URL}qemu/`

/** file_packager.py stub that fetches and mounts the .data blob at /pack/. */
const PACKAGE_SCRIPT = 'load.js'

/**
 * Flipped the moment we touch document-global state — assigning `globalThis.
 * Module` or injecting `load.js`. Those are not undoable: `load.js` appends its
 * .data-fetching hooks to Module.preRun, and PROXY_TO_PTHREAD spawns workers
 * bound to that one instance. A second boot in the same document wedges rather
 * than restarts, so once this is set the only way back is a reload.
 *
 * Everything that can fail is checked *before* this flips, so a missing-asset
 * or missing-isolation error leaves the page clean and the user can switch back
 * to the mock backend without reloading.
 */
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
  /**
   * Emscripten exports these thin aliases for FS.createPath / FS.createDataFile
   * rather than the whole FS object — they are what file_packager itself uses,
   * so they are present in any build that supports a .data bundle.
   */
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

/* Two different failures need two different fixes, so keep them distinct. */

/** Nothing there: the artifacts have not been built (or were never dropped in). */
const NOT_BUILT_HINT = 'Run tools/build-qemu-wasm.sh — see public/qemu/README.md.'

/**
 * An HTML answer is genuinely ambiguous and must not claim to know which cause
 * it is: Vite serves its SPA index.html at HTTP 200 both for a file that was
 * never built and for one added under an already-running server, since public/
 * is only indexed at startup.
 */
const NOT_SERVED_HINT =
  'Either it has not been built (run tools/build-qemu-wasm.sh) or the dev server ' +
  'needs restarting — public/ is only indexed at startup.'

/**
 * Writes one guest file into the Emscripten filesystem. Must be called from
 * preRun, once the FS exists but before main() looks for the image.
 */
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
  // FS.createPath splits and creates each component itself, and is a no-op for
  // directories that already exist.
  if (parts.length) FS_createPath('/', parts.join('/'), true, true)
  FS_createDataFile(`/${parts.join('/')}`, name, bytes, true, true, true)
}

/** Fetches a guest file as bytes so preRun, which cannot await, can write it. */
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
  // A 200 alone proves nothing: Vite's dev server answers unknown paths with the
  // SPA index.html shell, and most static hosts do the same for a 404 fallback.
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/html')) {
    throw new Error(`${file} is not being served. ${NOT_SERVED_HINT}`)
  }
}

export function createQemuBackend(): PtyBackend {
  return {
    id: 'qemu',
    label: 'QEMU',

    // Only true once the document has been committed to one QEMU instance.
    // Before that the session can be remounted normally, and forcing a page
    // reload would just discard the user's selection for no reason.
    get resetRequiresReload() {
      return documentTainted
    },

    async start(slave: Slave, { board, sampleId, onStatus, signal }: StartOptions) {
      if (documentTainted) {
        throw new Error('QEMU is already instantiated in this tab. Reload to start a new session.')
      }

      // ---- validation: everything below must be side-effect free ----

      // Without cross-origin isolation SharedArrayBuffer is unavailable, and
      // both xterm-pty's blocking reads and qemu-wasm's PROXY_TO_PTHREAD build
      // depend on it. Failing loudly here beats hanging on the first keystroke.
      if (!globalThis.crossOriginIsolated) {
        throw new Error(
          'Page is not cross-origin isolated. Serve it with ' +
            'Cross-Origin-Opener-Policy: same-origin and ' +
            'Cross-Origin-Embedder-Policy: require-corp.',
        )
      }

      // Deliberately not gated on __QEMU_ASSETS_PRESENT__: that flag is
      // computed when Vite starts, so it goes stale the moment artifacts are
      // built under a running server. It decides the *default* backend; whether
      // a start can actually succeed is settled here, against the server.
      const mainScript = `${board.qemuBinary}.js`
      onStatus({ status: 'loading', detail: 'checking assets' })
      await assertAsset(mainScript)
      await assertAsset(`${board.qemuBinary}.wasm`)
      if (board.usesDataBundle) await assertAsset(PACKAGE_SCRIPT)
      if (signal.aborted) return

      // preRun cannot await, so the guest files are fetched here and written
      // synchronously once the filesystem exists. A user-supplied ELF replaces
      // the kernel; anything else the board needs still comes from public/qemu/.
      const custom = getGuestImage()
      onStatus({
        status: 'loading',
        detail: custom ? `loading ${custom.name}` : `loading ${sampleId}`,
      })
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

      // ---- commit: from here the document belongs to this instance ----

      onStatus({ status: 'loading', detail: 'starting emulator' })

      const mod: QemuModule = {
        arguments: board.args,
        // The hook emscripten-pty.js reads: `$PTY: Module['pty']`.
        pty: slave,
        // pthread workers re-import the main script by absolute URL.
        mainScriptUrlOrBlob: url(mainScript),
        // Resolves the .wasm, .data and .worker.js siblings under /qemu/.
        // file_packager's load.js honours this too.
        locateFile: (path) => ASSET_BASE + path,
        // Guest stdout/stderr go through the TTY hooks, not here; this only
        // surfaces Emscripten's own runtime diagnostics.
        printErr: (text) => console.error('[qemu]', text),
        // Runs after the filesystem is up but before main(). load.js, when a
        // board uses one, appends its own .data hooks to this same array.
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

      // Classic script: it declares `var Module` and picks up the global we just
      // set, then appends its .data-fetching hooks to Module.preRun. Only needed
      // for guests whose image ships as a file_packager bundle.
      if (board.usesDataBundle) {
        await loadClassicScript(url(PACKAGE_SCRIPT))
        if (signal.aborted) return
      }

      // @vite-ignore keeps Vite from trying to resolve and bundle this at build
      // time — it is a static asset in public/, fetched at runtime.
      const factory = (await import(/* @vite-ignore */ url(mainScript))) as {
        default: (m: QemuModule) => Promise<QemuModule>
      }
      if (signal.aborted) return

      onStatus({ status: 'loading', detail: 'booting' })
      const instance = await factory.default(mod)

      // Mirrors the poll workaround in qemu-wasm's example page: report
      // readiness straight from the pty when it has nothing buffered, so a
      // blocked guest poll() does not stall waiting on the Emscripten TTY.
      // (Upstream's snippet writes `oldPoll.call(stream, timeout)`, dropping the
      // receiver; the receiver-preserving form below is what it means to do.)
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

      // Each emulator can contain optional browser bridge exports; board
      // metadata decides which bridges belong to the selected machine.
      if (board.peripherals?.hostSensor) attachHostSensor(instance)
      else detachHostSensor()
      // The panel becomes visible once a qemu,ramfb guest configures fw_cfg.
      if (board.peripherals?.ramfb) attachHostDisplay(instance)
      else detachHostDisplay()
      if (board.peripherals?.gnss) attachHostGnss(instance)
      else detachHostGnss()

      onStatus({ status: 'running', detail: custom ? custom.name : sampleId })
    },

    async reset() {
      detachHostSensor()
      detachHostDisplay()
      detachHostGnss()
      // Nothing global was touched, so there is nothing to tear down.
      if (!documentTainted) return
      // Emscripten modules cannot be torn down cleanly; a reload is the only
      // reliable restart. This never resolves — the document goes away.
      location.reload()
      await new Promise<never>(() => {})
    },
  }
}
