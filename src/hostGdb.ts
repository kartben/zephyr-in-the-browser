/**
 * Browser end of QEMU's gdbstub (RSP over the gdb0 browser chardev).
 *
 * Gated on features.json `"gdb"` and the `_qemu_browser_gdb_*` exports. Until
 * the emulator is rebuilt with the dual-channel chardev patch, attach() is a
 * no-op and the control façade keeps using QMP.
 */

import {
  bindChardev,
  chardevAvailable,
  type ChardevExports,
} from '@/debug/browserChardev'
import { RspClient, type RspClientOptions } from '@/debug/gdb/rspClient'
import { chardevRspTransport, type RspTransport } from '@/debug/gdb/rspTransport'
import {
  archFromBoard,
  breakpointKind,
  callInsnSizes,
  codeAddr,
  decodeGPacket,
  NO_FRAME_REGS,
  type FrameRegs,
  type GdbArch,
} from '@/debug/gdb/regs'
import {
  unwindStack,
  type StackFrame,
  type UnwindMethod,
  type UnwindResult,
} from '@/debug/callStack'
import { compactHex } from '@/debug/hexFormat'
import { parseThreadInfoFromElf, type ThreadInfo } from '@/debug/kernel/meta'
import { listThreads, type ZephyrThread } from '@/debug/kernel/threads'
import {
  objectCoreThreadAddresses,
  objectCoreWaitObjects,
  parseObjectCoreMeta,
  readObjectCores,
  type ObjectCoreMeta,
  type ObjectCoreSnapshot,
} from '@/debug/kernel/objectCores'
import { buildStackRegions, type StackRegion } from '@/debug/elfStacks'
import { buildWaitObjects, type WaitObject } from '@/debug/elfWaitObjects'
import { readElfDeviceNames, type ElfDeviceNames } from '@/debug/elfDevices'
import {
  buildSymbolIndex,
  formatSymbol,
  resolveSymbol,
  type ElfSymbol,
  type SymbolIndex,
} from '@/debug/elfSymbols'
import {
  buildFormalIndex,
  formalsAt,
  type FormalIndex,
} from '@/debug/dwarfFormals'
import { bytesToHex, hexToBytes } from '@/debug/gdb/rspCodec'

const POLL_MS = 20

export interface Breakpoint {
  addr: number
  /** Display hex, lowercase, no 0x. */
  addrHex: string
  /** Resolved function name, if the ELF has symbols. */
  label: string | null
}

export interface GdbState {
  available: boolean
  /** What the session talks to: the in-page QEMU stub, or a real board over the bridge. */
  source: 'qemu' | 'bridge' | null
  /** RSP session is live (attach succeeded). */
  attached: boolean
  paused: boolean
  pc: string | null
  /** Function+offset for the current PC, when symbols are available. */
  pcLabel: string | null
  summary: string | null
  registers: string | null
  registersLoading: boolean
  breakpoints: Breakpoint[]
  /** Last memory peek, if any. */
  memory: { addr: number; hex: string } | null
  /** Guest ELF has CONFIG_DEBUG_THREAD_INFO symbols. */
  threadInfo: boolean
  /** Guest ELF has CONFIG_OBJ_CORE metadata. */
  objectCores: boolean
  /** Function symbols from an unstripped ELF (for BP picker / labels). */
  hasSymbols: boolean
  symbols: ElfSymbol[]
  /** DWARF formal parameter names for the function containing PC. */
  regFormals: string[]
  /** gdb register layout arch — for ABI tooltips. */
  regArch: GdbArch | null
  threads: ZephyrThread[]
  threadsLoading: boolean
  threadsError: string | null
  objects: ObjectCoreSnapshot | null
  objectsLoading: boolean
  objectsError: string | null
  /** Call stack for the stopped context, innermost first. */
  stack: StackFrame[]
  /** How the frames past #0 were recovered — the UI flags scans as guesses. */
  stackMethod: UnwindMethod
  stackLoading: boolean
  /** More frames exist than we built (depth cap or scan window). */
  stackTruncated: boolean
}

const EMPTY: GdbState = {
  available: false,
  source: null,
  attached: false,
  paused: false,
  pc: null,
  pcLabel: null,
  summary: null,
  registers: null,
  registersLoading: false,
  breakpoints: [],
  memory: null,
  threadInfo: false,
  objectCores: false,
  hasSymbols: false,
  symbols: [],
  regFormals: [],
  regArch: null,
  threads: [],
  threadsLoading: false,
  threadsError: null,
  objects: null,
  objectsLoading: false,
  objectsError: null,
  stack: [],
  stackMethod: 'none',
  stackLoading: false,
  stackTruncated: false,
}

let kernelElf: Uint8Array | null = null
let attachHook: (() => Promise<void>) | null = null
let stopFilter: ((pc: string) => boolean) | null = null
let mod: Record<string, unknown> | null = null
let ch: ChardevExports | null = null
let client: RspClient | null = null
let arch: GdbArch = 'arm'
let threadInfo: ThreadInfo | null = null
let objectCoreMeta: ObjectCoreMeta | null = null
let symbolIndex: SymbolIndex | null = null
let formalIndex: FormalIndex | null = null
let stackRegions: StackRegion[] = []
let waitObjects: WaitObject[] = []
let deviceNames: ElfDeviceNames | null = null
let state: GdbState = EMPTY
let pollTimer: ReturnType<typeof setInterval> | null = null
/** Numeric PC/SP/FP/LR from the last `g` read — input to the unwinder. */
let frameRegs: FrameRegs = NO_FRAME_REGS
/** Breakpoint we planted for Step over / Step out / Run to, cleared on stop. */
let tempBp: number | null = null
/** Suppress the stop handler's refresh while a step sequence drives its own. */
let internalStep = false
const listeners = new Set<() => void>()

function labelFor(addr: number): string | null {
  return formatSymbol(resolveSymbol(symbolIndex, addr))
}

/** Read guest memory for the unwinder; null instead of throwing on a bad range. */
async function tryRead(addr: number, length: number): Promise<Uint8Array | null> {
  if (!client) return null
  try {
    return await client.readMemory(addr, length)
  } catch {
    return null
  }
}

function formalsForPc(pcNum: number): string[] {
  return formalsAt(formalIndex, pcNum)
}

function notify() {
  for (const fn of listeners) fn()
}

function publish(next: Partial<GdbState>) {
  state = { ...state, ...next }
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): GdbState {
  return state
}

/**
 * The guest ELF, for readers that want more out of it than this module parses
 * — the tour engine builds a DWARF line index from it on demand, and only when
 * a sample actually carries a tour.
 */
export function getKernelElf(): Uint8Array | null {
  return kernelElf
}

/** Symbol index for the running image (functions + data), or null. */
export function getSymbolIndex(): SymbolIndex | null {
  return symbolIndex
}

/**
 * Run `fn` at the stop that opening the stub produces, before the machine is
 * let go again.
 *
 * This is the only moment a tour can plant its breakpoints and be sure the
 * guest has not already run past them — attaching happens while the machine is
 * still in early boot, and `main()` is a long way after that.
 */
export function setAttachHook(fn: (() => Promise<void>) | null) {
  attachHook = fn
}

/**
 * Vet a stop before anything expensive happens to it.
 *
 * A full stop costs a register read, a memory peek, a thread walk and a stack
 * unwind — dozens of RSP round-trips — and publishes a pause the whole UI
 * reacts to. That is the right price for a stop somebody is going to look at,
 * and much too high for one that exists only to be counted: a tour step
 * conditioned on `hits % 10 == 0` rejects nine hits out of ten, and on a hot
 * breakpoint the rejected ones are the whole cost of the feature.
 *
 * The filter sees only the PC — one round-trip to get it — and returns true to
 * say "not this one". The machine is then let go without ever having looked
 * paused.
 *
 * @param fn Called with the stop PC as hex. Must not block: the guest is
 *           frozen until it answers.
 */
export function setStopFilter(fn: ((pc: string) => boolean) | null) {
  stopFilter = fn
}

/** ELF wait-queue objects (msgq/sem/…) for resolving CTF object ids to names. */
export function getWaitObjects(): WaitObject[] {
  return waitObjects
}

/**
 * `struct device *` → name, for the pointers the PM device events carry.
 *
 * Read straight out of the image, so unlike everything else here it needs no gdb
 * session at all — `name` is the first member of `struct device` and both it and
 * the string live in .rodata. See debug/elfDevices.ts.
 */
export function getDeviceNames(): ElfDeviceNames | null {
  return deviceNames
}

export function sessionActive(): boolean {
  return state.attached && (client !== null || devSession)
}

function startPoll() {
  stopPoll()
  pollTimer = setInterval(() => {
    client?.poll()
  }, POLL_MS)
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function refreshRegs() {
  if (!client || !state.paused) return
  publish({ registersLoading: true })
  try {
    const hex = await client.readRegisters()
    const view = decodeGPacket(arch, hex)
    const pc = view.pc
    const pcNum = pc ? Number.parseInt(pc, 16) : NaN
    const pcLabel = Number.isFinite(pcNum) ? labelFor(pcNum) : null
    const regFormals = Number.isFinite(pcNum) ? formalsForPc(pcNum) : []
    const summary = pcLabel
      ? `${pcLabel}`
      : pc
        ? `PC ${compactHex(pc)}`
        : view.summary
    frameRegs = view.frame
    publish({
      registers: view.dump,
      pc,
      pcLabel,
      summary,
      regFormals,
      regArch: arch,
      registersLoading: false,
    })
  } catch {
    publish({ registersLoading: false })
  }
  // First stop (or cleared peek): fill a PC-centered window before the thread
  // walk saturates the RSP pipe, so Mem has bytes as soon as it mounts.
  if (state.paused && !state.memory && state.pc) {
    let addr = Number.parseInt(state.pc, 16)
    if (Number.isFinite(addr)) {
      if (arch === 'arm') addr &= ~1
      addr = Math.floor(addr / 16) * 16
      await readMemory(addr, 256)
    }
  } else {
    void refreshMemory()
  }
  // Object cores first: their typed live inventory drives thread enumeration
  // and resolves wait-queue pointers without ELF-name guessing.
  await refreshObjects()
  // Threads next: the walk gives the current thread's stack bounds, which is
  // what stops the unwinder's scan from running off the end of the stack.
  await refreshThreads()
  await refreshStack()
}

/**
 * Re-read the last peeked window so the hex view can blink bytes that changed
 * since the previous stop (pause → resume → pause).
 */
async function refreshMemory() {
  if (!client || !state.paused || !state.memory) return
  const { addr, hex } = state.memory
  const length = hex.length / 2
  if (length <= 0) return
  try {
    const bytes = await client.readMemory(addr, length)
    publish({ memory: { addr, hex: bytesToHex(bytes) } })
  } catch {
    // keep the previous peek
  }
}

async function refreshThreads() {
  if (!client || !state.paused || !threadInfo) {
    publish({ threads: [], threadsLoading: false, threadsError: null })
    return
  }
  publish({ threadsLoading: true, threadsError: null })
  try {
    const coreWaits = state.objects ? objectCoreWaitObjects(state.objects) : []
    const coreThreads = state.objects ? objectCoreThreadAddresses(state.objects) : []
    const threads = await listThreads(
      threadInfo,
      async (addr, length) => {
        if (!client) throw new Error('no client')
        return client.readMemory(addr, length)
      },
      {
        stacks: stackRegions,
        waitObjects: coreWaits.length > 0 ? coreWaits : waitObjects,
        threadAddrs: coreThreads,
      },
    )
    publish({ threads, threadsLoading: false, threadsError: null })
  } catch (err) {
    publish({
      threads: [],
      threadsLoading: false,
      threadsError: err instanceof Error ? err.message : 'Thread walk failed',
    })
  }
}

async function refreshObjects() {
  if (!client || !state.paused || !objectCoreMeta) {
    publish({ objects: null, objectsLoading: false, objectsError: null })
    return
  }
  publish({ objectsLoading: true, objectsError: null })
  try {
    const objects = await readObjectCores(objectCoreMeta, async (addr, length) => {
      if (!client) throw new Error('no client')
      return client.readMemory(addr, length)
    })
    publish({ objects, objectsLoading: false, objectsError: null })
  } catch (err) {
    publish({
      objects: null,
      objectsLoading: false,
      objectsError: err instanceof Error ? err.message : 'Object-core walk failed',
    })
  }
}

/**
 * Rebuild the call stack for the stopped CPU context.
 *
 * Needs symbols: without a symtab every candidate return address is
 * unresolvable, so the walk would be a wall of bare addresses — show frame 0
 * and stop rather than burn RSP round-trips on a scan that cannot judge a hit.
 */
async function refreshStack() {
  if (!client || !state.paused) return
  const pc = frameRegs.pc
  if (!symbolIndex) {
    const only: StackFrame[] = pc
      ? [{ addr: codeAddr(arch, pc), label: null, fn: null, origin: 'pc', slot: null }]
      : []
    publish({ stack: only, stackMethod: 'none', stackLoading: false, stackTruncated: false })
    return
  }

  publish({ stackLoading: true })
  const current = state.threads.find((t) => t.current) ?? null
  try {
    const result = await unwindStack({
      arch,
      pc,
      sp: frameRegs.sp,
      fp: frameRegs.fp,
      lr: frameRegs.lr,
      stackStart: current?.stackStart ?? null,
      stackSize: current?.stackSize ?? null,
      read: tryRead,
      resolve: (addr) => resolveSymbol(symbolIndex, addr),
    })
    publish({
      stack: result.frames,
      stackMethod: result.method,
      stackTruncated: result.truncated,
      stackLoading: false,
    })
  } catch {
    publish({ stack: [], stackMethod: 'none', stackTruncated: false, stackLoading: false })
  }
}

/**
 * Call stack for a thread that is not the running one.
 *
 * Its registers live in a saved switch handle we do not decode, so there is no
 * PC or frame pointer to start from — only the saved SP. That means a scan,
 * and the pane says so.
 */
export async function unwindThreadStack(tcbAddr: number): Promise<UnwindResult> {
  const empty: UnwindResult = { frames: [], method: 'none', truncated: false }
  if (!client || !state.paused || !symbolIndex) return empty
  const thread = state.threads.find((t) => t.addr === tcbAddr)
  if (!thread || thread.sp == null) return empty
  try {
    return await unwindStack({
      arch,
      pc: null,
      sp: thread.sp,
      stackStart: thread.stackStart,
      stackSize: thread.stackSize,
      read: tryRead,
      resolve: (addr) => resolveSymbol(symbolIndex, addr),
    })
  } catch {
    return empty
  }
}

/**
 * Parse CONFIG_DEBUG_THREAD_INFO + function symbols from the guest ELF.
 * Needs an unstripped image; safe no-op on stripped ELFs.
 */
export function setKernelImage(elf: Uint8Array | null) {
  kernelElf = elf
  threadInfo = elf ? parseThreadInfoFromElf(elf) : null
  objectCoreMeta = elf ? parseObjectCoreMeta(elf) : null
  symbolIndex = elf ? buildSymbolIndex(elf) : null
  formalIndex = elf ? buildFormalIndex(elf) : null
  stackRegions = elf ? buildStackRegions(elf) : []
  waitObjects = elf ? buildWaitObjects(elf) : []
  deviceNames = elf ? readElfDeviceNames(elf) : null
  if (state.available || state.attached) {
    publish({
      threadInfo: threadInfo !== null,
      objectCores: objectCoreMeta !== null,
      hasSymbols: symbolIndex !== null,
      symbols: symbolIndex?.byName ?? [],
      regFormals: [],
      threads: [],
      threadsError: null,
      objects: null,
      objectsError: null,
      stack: [],
      stackMethod: 'none',
    })
  }
}

/**
 * Bind the gdb exports from the emulator module.
 * Does not open the stub yet — call {@link attachSession} after boot.
 */
export function bind(module: unknown, boardArch: string) {
  const keptElf = kernelElf
  const keptInfo = threadInfo
  const keptObjectCoreMeta = objectCoreMeta
  const keptSyms = symbolIndex
  const keptFormals = formalIndex
  const keptStacks = stackRegions
  const keptWaits = waitObjects
  detach()
  kernelElf = keptElf
  threadInfo = keptInfo
  objectCoreMeta = keptObjectCoreMeta
  symbolIndex = keptSyms
  formalIndex = keptFormals
  stackRegions = keptStacks
  waitObjects = keptWaits
  mod = module as Record<string, unknown>
  ch = bindChardev(mod, 'gdb')
  arch = archFromBoard(boardArch)
  const available = chardevAvailable(ch) && typeof mod._qemu_browser_gdb_attach === 'function'
  publish({
    ...EMPTY,
    available,
    source: available ? 'qemu' : null,
    threadInfo: threadInfo !== null,
    objectCores: objectCoreMeta !== null,
    hasSymbols: symbolIndex !== null,
    symbols: symbolIndex?.byName ?? [],
    regArch: arch,
  })
}

/**
 * The Live board analogue of {@link bind}: make the debugger available for a
 * session over the desktop bridge, with no wasm module behind it. Same
 * kept-index dance, so a rebind never costs the parsed ELF.
 *
 * @param liveArch From the dropped symbol ELF's e_machine when known; null
 *   keeps the default (the panel offers a picker in that degraded state).
 */
export function bindLive(liveArch: GdbArch | null) {
  const keptElf = kernelElf
  const keptInfo = threadInfo
  const keptObjectCoreMeta = objectCoreMeta
  const keptSyms = symbolIndex
  const keptFormals = formalIndex
  const keptStacks = stackRegions
  const keptWaits = waitObjects
  detach()
  kernelElf = keptElf
  threadInfo = keptInfo
  objectCoreMeta = keptObjectCoreMeta
  symbolIndex = keptSyms
  formalIndex = keptFormals
  stackRegions = keptStacks
  waitObjects = keptWaits
  arch = liveArch ?? 'arm'
  publish({
    ...EMPTY,
    available: true,
    source: 'bridge',
    threadInfo: threadInfo !== null,
    objectCores: objectCoreMeta !== null,
    hasSymbols: symbolIndex !== null,
    symbols: symbolIndex?.byName ?? [],
    regArch: arch,
  })
}

/**
 * Register layout for a live session — from a later-dropped ELF, or the
 * panel's picker when no ELF says. Safe mid-session: the wire protocol never
 * carries the arch, only the `g`-blob decoding does.
 */
export function setLiveArch(next: GdbArch) {
  if (state.source !== 'bridge') return
  arch = next
  publish({ regArch: arch })
}

/** Open the gdbstub and start an RSP session. Safe to call when unavailable. */
export async function attachSession(): Promise<boolean> {
  if (!mod || !ch || !state.available) return false
  const attach = mod._qemu_browser_gdb_attach as (() => number) | undefined
  if (!attach) return false

  // Chardev creation races the module factory under wasm pthreads — retry.
  let opened = false
  for (let i = 0; i < 25; i++) {
    if (attach() === 0) {
      opened = true
      break
    }
    await sleep(100)
  }
  if (!opened) {
    console.warn('[gdb] gdb0 chardev not ready; staying on QMP')
    return false
  }

  // OPENED is applied on QEMU's drain timer (~20 ms); give it a beat.
  await sleep(50)

  const det = mod._qemu_browser_gdb_detach as (() => void) | undefined
  return openSession(chardevRspTransport(ch), {
    runAttachHook: true,
    onFail: () => det?.(),
  })
}

/**
 * The transport-agnostic core of attaching: handshake, stop wiring, the
 * initial-object snapshot, and the resume that keeps the machine from
 * sitting frozen at the attach stop. Callers own everything before the
 * transport exists (QEMU's chardev-open dance, the bridge's ctrl attach).
 */
async function openSession(
  transport: RspTransport,
  opts: {
    clientOpts?: RspClientOptions
    /**
     * Tours plant breakpoints at the attach stop. Simulator only — firing
     * sample-tour hooks at a physical board would plant them in whatever
     * firmware happens to be flashed.
     */
    runAttachHook: boolean
    onFail?: () => void
  },
): Promise<boolean> {
  const next = new RspClient(transport, opts.clientOpts)
  let starting = true
  next.setStopHandler((info) => {
    if (info.kind !== 'signal') return
    // start() asks "why are you stopped?" as part of the handshake. That
    // reply is consumed explicitly below; do not launch a second, concurrent
    // full refresh from the ordinary asynchronous stop path.
    if (starting) return
    // Step over / out drive their own refresh once they know where they
    // landed — let them, instead of racing a full walk per intermediate stop.
    if (internalStep) {
      // Mark regs loading with the pause so Mem cannot seed from 0x0 in the
      // gap before refreshRegs() runs.
      publish({ paused: true, registersLoading: true })
      return
    }
    void (async () => {
      // Ask the filter first, and publish nothing until it has answered: a
      // rejected stop must not flicker the UI into "paused" or trigger the
      // reads below. Reading the registers is what the full refresh would
      // have started with anyway, so a kept stop pays nothing extra.
      if (stopFilter) {
        let pc: string | null = null
        try {
          pc = decodeGPacket(arch, await next.readRegisters()).pc
        } catch {
          pc = null
        }
        if (pc !== null && stopFilter(pc)) {
          await clearTempBreakpoint()
          await next.continue()
          return
        }
      }
      publish({ paused: true, registersLoading: true })
      await clearTempBreakpoint()
      await refreshRegs()
    })()
  })
  client = next
  // Push transports (the bridge) wake the poll at message latency; the 20 ms
  // timer stays as the floor for pull transports and as a safety net.
  transport.setOnData?.(() => next.poll())
  startPoll()

  try {
    next.poll()
    const stop = await next.start()
    starting = false
    // Claim the session before the hook runs: planting a breakpoint goes
    // through the same guards Pause does, and they check `attached`.
    publish({ attached: true, paused: stop !== null })
    // The descriptor section can seed static object cores even when this stop
    // precedes Zephyr's z_obj_core_init_all(). Keep that snapshot through the
    // initial continue so Trace has exact fixed bounds before app code runs.
    if (stop && objectCoreMeta) {
      await refreshObjects()
    }
    if (opts.runAttachHook && attachHook) {
      try {
        await attachHook()
      } catch (err) {
        console.warn('[gdb] attach hook failed', err)
      }
    }
    // Attaching often stops the machine (QEMU's chardev open, OpenOCD's
    // gdb-attach halt); kick it again so nothing is left frozen until the
    // user notices Pause.
    if (stop) {
      await next.continue()
    }
    publish({ paused: false })
    console.info('[gdb] RSP session attached')
    return true
  } catch (err) {
    console.warn('[gdb] RSP handshake failed', err)
    stopPoll()
    transport.setOnData?.(null)
    client = null
    opts.onFail?.()
    publish({ attached: false, paused: false })
    return false
  }
}

/**
 * Open an RSP session over the desktop bridge. bindLive() must have run.
 * Tour hooks never fire here (see openSession's runAttachHook note).
 */
export async function attachLiveSession(transport: RspTransport): Promise<boolean> {
  if (state.source !== 'bridge' || !state.available) return false
  return openSession(transport, {
    clientOpts: {
      eagerAcks: true,
      probeVCont: true,
      hwBreakpointFallback: true,
      resolveUnknownStop: true,
    },
    runAttachHook: false,
    onFail: () => transport.close?.(),
  })
}

/**
 * Tear down the live session locally — the caller owns the wire (ctrl-level
 * gdb-detach, or a WebSocket that is already gone). Keeps the ELF indexes by
 * default so a bridge blip does not cost the user their symbols; the state
 * returns to bound-but-unattached, ready for a re-attach.
 */
export function detachLive(opts?: { keepImage?: boolean }) {
  if (state.source !== 'bridge') return
  stopPoll()
  client = null
  frameRegs = NO_FRAME_REGS
  tempBp = null
  internalStep = false
  if (opts?.keepImage === false) setKernelImage(null)
  state = {
    ...EMPTY,
    available: true,
    source: 'bridge',
    threadInfo: threadInfo !== null,
    objectCores: objectCoreMeta !== null,
    hasSymbols: symbolIndex !== null,
    symbols: symbolIndex?.byName ?? [],
    regArch: arch,
  }
  notify()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function detach() {
  stopPoll()
  if (mod && state.attached) {
    const det = mod._qemu_browser_gdb_detach as (() => void) | undefined
    det?.()
  }
  client = null
  ch = null
  mod = null
  /*
   * `attachHook` and `stopFilter` are deliberately *not* cleared. They are the
   * page's wiring, registered once by the tour store and outliving any one
   * machine — and bind() detaches first, so clearing them here unregistered
   * whatever had already been set up for the guest about to start. That put a
   * tour in a state where it still planted its breakpoints (via the hook) but
   * never saw the stops (no filter): breakpoints in the panel, and no card,
   * with nothing to say why. The store clears both in its own reset().
   */
  frameRegs = NO_FRAME_REGS
  tempBp = null
  internalStep = false
  kernelElf = null
  threadInfo = null
  objectCoreMeta = null
  symbolIndex = null
  formalIndex = null
  stackRegions = []
  waitObjects = []
  state = EMPTY
  notify()
}

/**
 * Coalesce Pause clicks.
 *
 * A stop costs a register read, a memory peek, an object-core walk, a thread
 * walk and a stack unwind — enough RSP round-trips that a second click lands
 * well inside the first one's refresh. Without this each click started its own
 * cascade, and the two interleaved on a pipe that answers one packet at a time.
 */
let pausePending: Promise<void> | null = null

export async function pause(): Promise<void> {
  const c = client
  if (!c || !state.attached) return
  if (state.paused) return
  if (pausePending) return pausePending
  pausePending = (async () => {
    try {
      await c.interrupt()
      publish({ paused: true, registersLoading: true })
      await clearTempBreakpoint()
      await refreshRegs()
    } catch (err) {
      console.warn('[gdb] pause failed', err)
    } finally {
      pausePending = null
    }
  })()
  return pausePending
}

/**
 * Let the machine go.
 *
 * Deliberately not gated on `state.paused`. That guard was how a stall became
 * permanent: once anything left the flag false over a stopped machine, Resume
 * refused to send `vCont;c` and nothing could restart the guest. `continue()`
 * is a no-op on a machine that is already running, so asking is always safe.
 */
export async function resume(): Promise<void> {
  if (!client || !state.attached) return
  try {
    await client.continue()
    // Keep the last register / memory / thread snapshot so the inspect tabs
    // can stay visible (grayed) while running — makes the next-pause blink
    // against a frozen baseline.
    publish({
      paused: false,
      registersLoading: false,
      threadsLoading: false,
      objectsLoading: false,
    })
  } catch {
    // ignore
  }
}

export async function step(): Promise<void> {
  if (!client || !state.attached || !state.paused) return
  try {
    internalStep = true
    await client.step()
    publish({ paused: true, registersLoading: true })
    await clearTempBreakpoint()
    await refreshRegs()
  } catch {
    // ignore
  } finally {
    internalStep = false
  }
}

/** Drop the Step over / Step out / Run to breakpoint once it has done its job. */
async function clearTempBreakpoint(): Promise<void> {
  const addr = tempBp
  tempBp = null
  if (addr === null || !client) return
  // A user breakpoint at the same address must survive.
  if (state.breakpoints.some((b) => b.addr === addr)) return
  try {
    await client.removeSwBreakpoint(addr, breakpointKind(arch))
  } catch {
    // the stub drops it on detach anyway
  }
}

/**
 * Continue until `addr` is reached (Step out, or a click on a caller frame).
 *
 * A one-shot breakpoint, not a watched condition: recursion can stop one level
 * shallower than you meant, and if the address is never reached the guest just
 * keeps running until you Pause. That is the honest cost of not tracking frames
 * across a resume, and cheap to recover from.
 */
export async function runTo(addr: number): Promise<boolean> {
  if (!client || !state.attached || !state.paused) return false
  const target = codeAddr(arch, addr)
  if (!state.breakpoints.some((b) => b.addr === target)) {
    const ok = await client.insertSwBreakpoint(target, breakpointKind(arch))
    if (!ok) return false
    tempBp = target
  }
  await resume()
  return true
}

/** Run until the current function returns to its caller (call stack frame #1). */
export async function stepOut(): Promise<boolean> {
  if (!client || !state.attached || !state.paused) return false
  const caller = state.stack[1]
  if (!caller) return false
  return runTo(caller.addr)
}

/**
 * Step one instruction, but run calls to completion.
 *
 * Without a disassembler we cannot see a `bl` coming, so we step first and ask
 * afterwards: if the return-address register now points at the instruction
 * right after where we were, that step entered a call — so continue to it.
 */
export async function stepOver(): Promise<void> {
  if (!client || !state.attached || !state.paused) return
  const fromPc = frameRegs.pc != null ? codeAddr(arch, frameRegs.pc) : null
  try {
    internalStep = true
    await client.step()
    publish({ paused: true, registersLoading: true })
    await clearTempBreakpoint()

    if (fromPc !== null) {
      let landed: FrameRegs | null = null
      try {
        landed = decodeGPacket(arch, await client.readRegisters()).frame
      } catch {
        landed = null
      }
      const ret = landed?.lr != null ? codeAddr(arch, landed.lr) : null
      const now = landed?.pc != null ? codeAddr(arch, landed.pc) : null
      const enteredCall =
        ret !== null &&
        now !== null &&
        now !== ret &&
        callInsnSizes(arch).some((size) => ret === fromPc + size)
      if (enteredCall && ret !== null) {
        internalStep = false
        if (await runTo(ret)) return
        internalStep = true
      }
    }

    await refreshRegs()
  } catch {
    // ignore
  } finally {
    internalStep = false
  }
}

/**
 * Run `fn` with the machine halted, then put it back the way it was.
 *
 * Breakpoint edits are the one bit of stub traffic reachable while the guest
 * runs, and the stub cannot take them then: QEMU stops the vCPU on any byte
 * that arrives mid-run and sends no stop reply, so the edit would land and the
 * guest would freeze with the page still showing "running". Halting first costs
 * a round-trip and keeps that from happening. `paused` is left alone — this is
 * a hiccup in the guest's execution, not a pause anybody asked to look at.
 */
async function whileStopped<T>(fn: () => Promise<T>): Promise<T> {
  const c = client
  if (!c) throw new Error('gdb: no session')
  if (!c.isRunning()) return fn()
  await c.interrupt()
  try {
    return await fn()
  } finally {
    await c.continue()
  }
}

export async function addBreakpoint(addr: number): Promise<boolean> {
  if (!client || !state.attached) return false
  const kind = breakpointKind(arch)
  const ok = await whileStopped(() => client!.insertSwBreakpoint(addr, kind))
  if (ok) {
    const bp: Breakpoint = {
      addr,
      addrHex: addr.toString(16),
      label: labelFor(addr),
    }
    if (!state.breakpoints.some((b) => b.addr === addr)) {
      publish({ breakpoints: [...state.breakpoints, bp] })
    }
  }
  return ok
}

export async function removeBreakpoint(addr: number): Promise<boolean> {
  if (!client || !state.attached) return false
  const kind = breakpointKind(arch)
  const ok = await whileStopped(() => client!.removeSwBreakpoint(addr, kind))
  if (ok) {
    publish({ breakpoints: state.breakpoints.filter((b) => b.addr !== addr) })
  }
  return ok
}

export async function readMemory(addr: number, length = 64): Promise<string | null> {
  if (!client || !state.attached || !state.paused) return null
  try {
    const bytes = await client.readMemory(addr, length)
    const hex = bytesToHex(bytes)
    publish({ memory: { addr, hex } })
    return hex
  } catch {
    return null
  }
}

/**
 * Peek guest memory without publishing to the Mem pane — used while scanning
 * so the hex view does not flicker through every chunk.
 */
export async function readMemoryRaw(addr: number, length: number): Promise<Uint8Array | null> {
  if (!client || !state.attached || !state.paused) return null
  try {
    return await client.readMemory(addr, length)
  } catch {
    return null
  }
}

/**
 * Replace the cached peek window (Mem slide / search hit) without an RSP round-trip.
 */
export function setMemoryWindow(addr: number, data: Uint8Array) {
  publish({ memory: { addr: addr >>> 0, hex: bytesToHex(data) } })
}

/**
 * Patch the cached peek window without a round-trip — used when the hex view
 * edits a byte locally so a remount does not lose the change.
 */
export function patchMemoryCache(addr: number, data: Uint8Array) {
  const peek = state.memory
  if (!peek || data.length === 0) return
  const peekLen = peek.hex.length / 2
  const peekEnd = peek.addr + peekLen
  const writeEnd = addr + data.length
  if (addr >= peekEnd || writeEnd <= peek.addr) return
  const next = hexToBytes(peek.hex)
  const copyStart = Math.max(0, addr - peek.addr)
  const dataStart = Math.max(0, peek.addr - addr)
  const copyLen = Math.min(peekLen - copyStart, data.length - dataStart)
  next.set(data.subarray(dataStart, dataStart + copyLen), copyStart)
  publish({ memory: { addr: peek.addr, hex: bytesToHex(next) } })
}

/** Write guest memory at `addr`. */
export async function writeMemory(addr: number, data: Uint8Array): Promise<boolean> {
  if (!client || !state.attached || !state.paused || data.length === 0) return false
  try {
    await client.writeMemory(addr, data)
    return true
  } catch {
    return false
  }
}

/** Test helper. */
export function resetForTests() {
  detach()
}

/** Dev-only: show the Debug stage card without a live gdbstub (screenshots / UI). */
export function debugForceAvailable() {
  publish({ available: true })
}

/**
 * Dev-only: pretend an RSP session is attached and stopped, so the panel's
 * paused surfaces (CPU / Stack / Mem / Threads) can be laid out and
 * screenshotted without a ~100 MB emulator build. Run control does nothing —
 * there is no stub behind it.
 */
let devSession = false

export function debugForceSession(next: Partial<GdbState>) {
  // Guarded: a fake session routes run control at a stub that is not there.
  if (!import.meta.env.DEV) return
  devSession = true
  publish({ available: true, attached: true, paused: true, ...next })
}

if (import.meta.env.DEV) {
  const hooks = globalThis as unknown as {
    __zephyrGdbForceAvailable?: typeof debugForceAvailable
    __zephyrGdbForceSession?: typeof debugForceSession
  }
  hooks.__zephyrGdbForceAvailable = debugForceAvailable
  hooks.__zephyrGdbForceSession = debugForceSession
}
