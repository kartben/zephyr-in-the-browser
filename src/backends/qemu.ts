import { attach as attachHostDisplay, detach as detachHostDisplay } from '@/hostDisplay'
import { attach as attachHostGnss, detach as detachHostGnss } from '@/hostGnss'
import { attach as attachHostGpio, detach as detachHostGpio } from '@/hostGpio'
import { attach as attachHostAudio, detach as detachHostAudio } from '@/hostAudio'
import { attach as attachHostMic, detach as detachHostMic } from '@/hostMic'
import { attach as attachGuestStats, detach as detachGuestStats } from '@/guestStats'
import { attach as attachHostNet, detach as detachHostNet } from '@/hostNet'
import { attach as attachHostInput, detach as detachHostInput } from '@/hostInput'
import { attach as attachHostTrace, detach as detachHostTrace } from '@/hostTrace'
import { attach as attachHostDisk, detach as detachHostDisk } from '@/hostDisk'
import {
  attach as attachHostMonitor,
  detach as detachHostMonitor,
  kick as kickMonitor,
} from '@/hostMonitor'
import {
  attach as attachHostBt,
  detach as detachHostBt,
  startController as prepareHostBtController,
} from '@/hostBt'
import {
  bind as bindHostGdb,
  attachSession as attachHostGdbSession,
  detach as detachHostGdb,
  setKernelImage as setHostGdbKernelImage,
} from '@/hostGdb'
import { attach as attachVirtio, detach as detachVirtio } from '@/virtio'
import { hasTour } from '@/tours/catalog'
import { get as getGuestImage } from '@/guestImage'
import { get as getDeviceTree, loadSampleDts } from '@/devicetree'
import {
  GDB_ARGS,
  HCI_ARGS,
  MONITOR_ARGS,
  getSample,
  sampleAsset,
  sampleDtsAsset,
  sampleFlashAsset,
} from '@/boards'
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

/**
 * Which optional bridges this emulator build has.
 *
 * tools/package-emulator.sh writes features.json beside the artifacts. A build
 * from before it exists answers 404, which reads as "none" — exactly right,
 * because that build predates the bridges the file would have listed.
 *
 * This matters for argv specifically: QEMU exits on an unknown `-chardev`
 * backend, so guessing wrong here would make every older image tarball fail to
 * boot rather than merely lose a feature.
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
      // The sample's devicetree rides along, ungated: it must never delay or
      // fail a boot, and its absence (an older image tarball) is a supported
      // state that just means the panels fall back to their static tables. A
      // custom ELF's tree, if any, was installed by the drop flow instead.
      if (!custom) {
        void loadSampleDts(url(sampleDtsAsset(board, sampleId)), `${sampleId}.dts`)
      }
      const sample = getSample(board, sampleId)
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
        // Boards that boot from emulated flash need the merged image too, and
        // it is per sample rather than per board. A custom ELF cannot replace
        // it: the drop flow supplies a kernel, and there is nothing to merge it
        // into, so such a board keeps booting its packaged image.
        ...(board.flashFsPath
          ? [
              {
                fsPath: board.flashFsPath,
                bytes: await fetchAsset(sampleFlashAsset(board, sampleId)),
              },
            ]
          : []),
        // Blank backing stores (a virtio-blk disk, say) are allocated rather
        // than fetched. They must stay *after* the kernel, which is indexed
        // positionally just below.
        ...(sample.blankFiles ?? []).map((f) => ({
          fsPath: f.fsPath,
          bytes: new Uint8Array(f.bytes),
        })),
      ]
      // Resolve CONFIG_DEBUG_THREAD_INFO symbols from the (unstripped) guest ELF.
      setHostGdbKernelImage(preloaded[0]!.bytes)
      if (signal.aborted) return

      // ---- commit: from here the document belongs to this instance ----

      onStatus({ status: 'loading', detail: 'starting emulator' })

      // Monitor / gdb are properties of the build, not of the machine, so they
      // are appended here rather than baked into each board's argv. The
      // sample's own devices come last, for the same reason: they belong to
      // the program, not the machine.
      const features = await emulatorFeatures()
      let args = [...board.args]
      if (features.has('monitor')) args = [...args, ...MONITOR_ARGS]
      if (features.has('gdb')) args = [...args, ...GDB_ARGS]
      if (features.has('hci') && board.peripherals?.hostBt) args = [...args, ...HCI_ARGS]
      if (sample.extraArgs) args = [...args, ...sample.extraArgs]

      /*
       * A tour breaks in places the guest passes exactly once — `main()`, a
       * driver's configure call, the six `k_thread_create()`s of a startup.
       * Opening the gdbstub stops the machine, but only once the chardev is up,
       * and Zephyr reaches `main()` in less time than that takes: the tour
       * planted its first breakpoint at an address the guest was already past,
       * and nothing ever fired. So freeze the CPU at reset and let the attach
       * below start it, once every anchor is resolved and step one is planted.
       */
      const frozen = features.has('gdb') && hasTour(sampleId)
      if (frozen) args = [...args, '-S']

      /*
       * A cold Pyodide + Bumble load takes longer than Zephyr's 10-second HCI
       * command timeout. Prepare the controller before main() so the guest's
       * first HCI Reset waits in the chardev ring for a ready consumer instead
       * of timing out while Bumble is still loading.
       *
       * Two ways to know this guest speaks Bluetooth before it says so: the
       * sample manifest, and the devicetree — a user ELF dropped with its
       * zephyr.dts declares its HCI UART there, and the tree is installed
       * before this boot starts. hostBt also starts the controller on the
       * first HCI packet, but that is a fallback with no head start, so it is
       * worth asking both questions here.
       */
      const bluetoothSample =
        (sample.primaryPanels?.includes('bluetooth') ?? false) ||
        (getDeviceTree()?.insights?.uartBuses.some((bus) => bus.role === 'bluetooth') ?? false)
      if (features.has('hci') && board.peripherals?.hostBt && bluetoothSample) {
        onStatus({ status: 'loading', detail: 'preparing Bluetooth controller' })
        await prepareHostBtController()
        if (signal.aborted) return
      }

      const mod: QemuModule = {
        arguments: args,
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
      // The generic virtio bridge goes first: hostGpio binds to a device model
      // running on it, and the models must be registered before it polls.
      if (board.peripherals?.virtio) attachVirtio(instance)
      else detachVirtio()
      // The panel becomes visible once a qemu,ramfb guest configures fw_cfg.
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
      // Gated on the sample rather than the board: a disk is per-sample, since
      // only the sample that declares one has an image to follow.
      if (sample.blankFiles?.length) attachHostDisk(instance)
      else detachHostDisk()
      if (features.has('hci') && board.peripherals?.hostBt) attachHostBt(instance)
      else detachHostBt()
      // Not gated on board metadata: the monitor is a property of the emulator
      // build, not of the machine it is emulating. attach() no-ops when the
      // exports are missing.
      attachHostMonitor(instance)
      if (features.has('gdb')) {
        bindHostGdb(instance, board.arch)
        // Attach after the machine is running so OPENED does not freeze boot.
        void attachHostGdbSession().then((ok) => {
          // `-S` (below) leaves the machine frozen at reset. Attaching resumes
          // it; if the stub never came up, nothing else will, so let it run.
          if (!ok && frozen) kickMonitor()
        })
      }

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
      detachHostBt()
      detachHostGdb()
      detachHostMonitor()
      // Nothing global was touched, so there is nothing to tear down.
      if (!documentTainted) return
      // Emscripten modules cannot be torn down cleanly; a reload is the only
      // reliable restart. This never resolves — the document goes away.
      location.reload()
      await new Promise<never>(() => {})
    },
  }
}
