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
import { bytesToHex } from '@/debug/gdb/rspCodec'

const POLL_MS = 20

export interface Breakpoint {
  addr: number
  /** Display hex, lowercase, no 0x. */
  addrHex: string
}

export interface GdbState {
  available: boolean
  /** RSP session is live (attach succeeded). */
  attached: boolean
  paused: boolean
  pc: string | null
  summary: string | null
  registers: string | null
  registersLoading: boolean
  breakpoints: Breakpoint[]
  /** Last memory peek, if any. */
  memory: { addr: number; hex: string } | null
}

const EMPTY: GdbState = {
  available: false,
  attached: false,
  paused: false,
  pc: null,
  summary: null,
  registers: null,
  registersLoading: false,
  breakpoints: [],
  memory: null,
}

let mod: Record<string, unknown> | null = null
let ch: ChardevExports | null = null
let client: RspClient | null = null
let arch: GdbArch = 'arm'
let state: GdbState = EMPTY
let pollTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

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
    publish({
      registers: view.dump,
      pc: view.pc,
      summary: view.summary,
      registersLoading: false,
    })
  } catch {
    publish({ registersLoading: false })
  }
}

/**
 * Bind the gdb exports from the emulator module.
 * Does not open the stub yet — call {@link attachSession} after boot.
 */
export function bind(module: unknown, boardArch: string) {
  detach()
  mod = module as Record<string, unknown>
  ch = bindChardev(mod, 'gdb')
  arch = archFromBoard(boardArch)
  const available = chardevAvailable(ch) && typeof mod._qemu_browser_gdb_attach === 'function'
  publish({ ...EMPTY, available })
}

/** Open the gdbstub and start an RSP session. Safe to call when unavailable. */
export async function attachSession(): Promise<boolean> {
  if (!mod || !ch || !state.available) return false
  const attach = mod._qemu_browser_gdb_attach as (() => number) | undefined
  if (!attach || attach() < 0) return false

  client = new RspClient(ch)
  client.setStopHandler((info) => {
    if (info.kind === 'signal') {
      publish({ paused: true })
      void refreshRegs()
    }
  })
  startPoll()
  publish({ attached: true, paused: false })

  try {
    // `\x03` if already running; `?` during start may report no stop yet.
    client.poll()
    await client.start()
    // Do not force a halt at attach — guest should keep running until Pause.
    publish({ attached: true, paused: false })
    return true
  } catch {
    // Stub connected but handshake failed — keep trying via interrupt later.
    publish({ attached: true })
    return true
  }
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
      summary: null,
      registers: null,
      registersLoading: false,
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
    const bp: Breakpoint = { addr, addrHex: addr.toString(16) }
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
