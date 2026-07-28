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
import { RspClient } from '@/debug/gdb/rspClient'
import {
  archFromBoard,
  breakpointKind,
  decodeGPacket,
  type GdbArch,
} from '@/debug/gdb/regs'
import { compactHex } from '@/debug/hexFormat'
import { parseThreadInfoFromElf, type ThreadInfo } from '@/debug/kernel/meta'
import { listThreads, type ZephyrThread } from '@/debug/kernel/threads'
import { buildStackRegions, type StackRegion } from '@/debug/elfStacks'
import { buildWaitObjects, type WaitObject } from '@/debug/elfWaitObjects'
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
import { bytesToHex } from '@/debug/gdb/rspCodec'

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
}

const EMPTY: GdbState = {
  available: false,
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
  hasSymbols: false,
  symbols: [],
  regFormals: [],
  regArch: null,
  threads: [],
  threadsLoading: false,
  threadsError: null,
}

let mod: Record<string, unknown> | null = null
let ch: ChardevExports | null = null
let client: RspClient | null = null
let arch: GdbArch = 'arm'
let threadInfo: ThreadInfo | null = null
let symbolIndex: SymbolIndex | null = null
let formalIndex: FormalIndex | null = null
let stackRegions: StackRegion[] = []
let waitObjects: WaitObject[] = []
let state: GdbState = EMPTY
let pollTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function labelFor(addr: number): string | null {
  return formatSymbol(resolveSymbol(symbolIndex, addr))
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

/** ELF wait-queue objects (msgq/sem/…) for resolving CTF object ids to names. */
export function getWaitObjects(): WaitObject[] {
  return waitObjects
}

export function sessionActive(): boolean {
  return state.attached && client !== null
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
  void refreshThreads()
}

async function refreshThreads() {
  if (!client || !state.paused || !threadInfo) {
    publish({ threads: [], threadsLoading: false, threadsError: null })
    return
  }
  publish({ threadsLoading: true, threadsError: null })
  try {
    const threads = await listThreads(
      threadInfo,
      async (addr, length) => {
        if (!client) throw new Error('no client')
        return client.readMemory(addr, length)
      },
      { stacks: stackRegions, waitObjects },
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

/**
 * Parse CONFIG_DEBUG_THREAD_INFO + function symbols from the guest ELF.
 * Needs an unstripped image; safe no-op on stripped ELFs.
 */
export function setKernelImage(elf: Uint8Array | null) {
  threadInfo = elf ? parseThreadInfoFromElf(elf) : null
  symbolIndex = elf ? buildSymbolIndex(elf) : null
  formalIndex = elf ? buildFormalIndex(elf) : null
  stackRegions = elf ? buildStackRegions(elf) : []
  waitObjects = elf ? buildWaitObjects(elf) : []
  if (state.available || state.attached) {
    publish({
      threadInfo: threadInfo !== null,
      hasSymbols: symbolIndex !== null,
      symbols: symbolIndex?.byName ?? [],
      regFormals: [],
      threads: [],
      threadsError: null,
    })
  }
}

/**
 * Bind the gdb exports from the emulator module.
 * Does not open the stub yet — call {@link attachSession} after boot.
 */
export function bind(module: unknown, boardArch: string) {
  const keptInfo = threadInfo
  const keptSyms = symbolIndex
  const keptFormals = formalIndex
  const keptStacks = stackRegions
  const keptWaits = waitObjects
  detach()
  threadInfo = keptInfo
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
    threadInfo: threadInfo !== null,
    hasSymbols: symbolIndex !== null,
    symbols: symbolIndex?.byName ?? [],
    regArch: arch,
  })
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

  const next = new RspClient(ch)
  next.setStopHandler((info) => {
    if (info.kind === 'signal') {
      publish({ paused: true })
      void refreshRegs()
    }
  })
  client = next
  startPoll()

  try {
    next.poll()
    const stop = await next.start()
    // Connecting the stub often stops the VM; kick it again so boot is not
    // left frozen until the user notices Pause.
    if (stop) {
      await next.continue()
    }
    // Only claim the session once RSP answers — otherwise Pause would leave
    // QMP and hang on a dead stub.
    publish({ attached: true, paused: false })
    console.info('[gdb] RSP session attached')
    return true
  } catch (err) {
    console.warn('[gdb] RSP handshake failed; staying on QMP', err)
    stopPoll()
    client = null
    const det = mod._qemu_browser_gdb_detach as (() => void) | undefined
    det?.()
    publish({ attached: false, paused: false })
    return false
  }
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
  threadInfo = null
  symbolIndex = null
  formalIndex = null
  stackRegions = []
  waitObjects = []
  state = EMPTY
  notify()
}

export async function pause(): Promise<void> {
  if (!client || !state.attached) return
  if (state.paused) return
  try {
    await client.interrupt()
    publish({ paused: true })
    await refreshRegs()
  } catch {
    // leave state; user can retry
  }
}

export async function resume(): Promise<void> {
  if (!client || !state.attached || !state.paused) return
  try {
    await client.continue()
    publish({
      paused: false,
      pc: null,
      pcLabel: null,
      summary: null,
      registers: null,
      registersLoading: false,
      threads: [],
      threadsLoading: false,
      threadsError: null,
    })
  } catch {
    // ignore
  }
}

export async function step(): Promise<void> {
  if (!client || !state.attached || !state.paused) return
  try {
    await client.step()
    publish({ paused: true })
    await refreshRegs()
  } catch {
    // ignore
  }
}

export async function addBreakpoint(addr: number): Promise<boolean> {
  if (!client || !state.attached) return false
  const kind = breakpointKind(arch)
  const ok = await client.insertSwBreakpoint(addr, kind)
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
  const ok = await client.removeSwBreakpoint(addr, kind)
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

/** Test helper. */
export function resetForTests() {
  detach()
}

/** Dev-only: show the Debug stage card without a live gdbstub (screenshots / UI). */
export function debugForceAvailable() {
  publish({ available: true })
}

if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __zephyrGdbForceAvailable?: typeof debugForceAvailable }).__zephyrGdbForceAvailable =
    debugForceAvailable
}
