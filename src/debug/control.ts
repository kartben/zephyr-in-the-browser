/**
 * Single control plane for pause / step / registers.
 *
 * When a gdb RSP session is attached, run-control goes through the stub.
 * Otherwise fall back to the QMP monitor (Step 1). Annotations and the TopBar
 * both call this module so they cannot diverge.
 */

import * as gdb from '@/hostGdb'
import * as monitor from '@/hostMonitor'
import type { ElfSymbol } from '@/debug/elfSymbols'
import type { ZephyrThread } from '@/debug/kernel/threads'
import type { ObjectCoreSnapshot } from '@/debug/kernel/objectCores'
import type { StackFrame, UnwindMethod, UnwindResult } from '@/debug/callStack'

export interface DebugSnapshot {
  /** Either bridge is present. */
  available: boolean
  /** gdbstub session is driving run-control. */
  gdb: boolean
  paused: boolean
  pc: string | null
  pcLabel: string | null
  summary: string | null
  registers: string | null
  registersLoading: boolean
  canStep: boolean
  breakpoints: { addr: number; addrHex: string; label: string | null }[]
  memory: { addr: number; hex: string } | null
  /** Guest ELF has CONFIG_DEBUG_THREAD_INFO symbols. */
  threadInfo: boolean
  /** Guest ELF has CONFIG_OBJ_CORE metadata. */
  objectCores: boolean
  hasSymbols: boolean
  symbols: ElfSymbol[]
  /** DWARF formals for the function at PC (empty if unknown). */
  regFormals: string[]
  /** Register ABI arch for hover hints. */
  regArch: 'arm' | 'aarch64' | 'riscv32' | null
  threads: ZephyrThread[]
  threadsLoading: boolean
  threadsError: string | null
  objects: ObjectCoreSnapshot | null
  objectsLoading: boolean
  objectsError: string | null
  /** Call stack for the stopped context, innermost first (gdb only). */
  stack: StackFrame[]
  stackMethod: UnwindMethod
  stackLoading: boolean
  stackTruncated: boolean
}

function snap(): DebugSnapshot {
  const g = gdb.getSnapshot()
  const m = monitor.getSnapshot()
  if (gdb.sessionActive()) {
    return {
      available: true,
      gdb: true,
      paused: g.paused,
      pc: g.pc,
      pcLabel: g.pcLabel,
      summary: g.summary,
      registers: g.registers,
      registersLoading: g.registersLoading,
      canStep: true,
      breakpoints: g.breakpoints,
      memory: g.memory,
      threadInfo: g.threadInfo,
      objectCores: g.objectCores,
      hasSymbols: g.hasSymbols,
      symbols: g.symbols,
      regFormals: g.regFormals,
      regArch: g.regArch,
      threads: g.threads,
      threadsLoading: g.threadsLoading,
      threadsError: g.threadsError,
      objects: g.objects,
      objectsLoading: g.objectsLoading,
      objectsError: g.objectsError,
      stack: g.stack,
      stackMethod: g.stackMethod,
      stackLoading: g.stackLoading,
      stackTruncated: g.stackTruncated,
    }
  }
  return {
    available: m.available,
    gdb: false,
    paused: m.paused,
    pc: m.pc,
    pcLabel: null,
    summary: m.summary,
    registers: m.registers,
    registersLoading: m.registersLoading,
    canStep: false,
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
}

const listeners = new Set<() => void>()
let last: DebugSnapshot = snap()

function emit() {
  const next = snap()
  last = next
  for (const fn of listeners) fn()
}

monitor.subscribe(emit)
gdb.subscribe(emit)

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): DebugSnapshot {
  return last
}

export function pause() {
  if (gdb.sessionActive()) void gdb.pause()
  else monitor.pause()
}

export function resume() {
  if (gdb.sessionActive()) void gdb.resume()
  else monitor.resume()
}

export function toggle() {
  if (getSnapshot().paused) resume()
  else pause()
}

export async function step(): Promise<void> {
  if (gdb.sessionActive()) await gdb.step()
}

/** Step one instruction, running any call it enters to completion. */
export async function stepOver(): Promise<void> {
  if (gdb.sessionActive()) await gdb.stepOver()
}

/** Continue until the current function returns to its caller. */
export async function stepOut(): Promise<boolean> {
  if (!gdb.sessionActive()) return false
  return gdb.stepOut()
}

/** Continue until `addr` is reached (one-shot breakpoint). */
export async function runTo(addr: number): Promise<boolean> {
  if (!gdb.sessionActive()) return false
  return gdb.runTo(addr)
}

/** Best-effort call stack for a thread that is not the running one. */
export async function unwindThreadStack(tcbAddr: number): Promise<UnwindResult> {
  if (!gdb.sessionActive()) return { frames: [], method: 'none', truncated: false }
  return gdb.unwindThreadStack(tcbAddr)
}

export async function addBreakpoint(addr: number): Promise<boolean> {
  if (!gdb.sessionActive()) return false
  return gdb.addBreakpoint(addr)
}

export async function removeBreakpoint(addr: number): Promise<boolean> {
  if (!gdb.sessionActive()) return false
  return gdb.removeBreakpoint(addr)
}

export async function readMemory(addr: number, length?: number): Promise<string | null> {
  if (!gdb.sessionActive()) return null
  return gdb.readMemory(addr, length)
}

/** Silent peek for Mem search — does not update the visible dump. */
export async function readMemoryRaw(addr: number, length: number): Promise<Uint8Array | null> {
  if (!gdb.sessionActive()) return null
  return gdb.readMemoryRaw(addr, length)
}

/** Publish a full Mem window from bytes already in hand (scroll slide). */
export function setMemoryWindow(addr: number, data: Uint8Array) {
  if (!gdb.sessionActive()) return
  gdb.setMemoryWindow(addr, data)
}

export function patchMemoryCache(addr: number, data: Uint8Array) {
  if (!gdb.sessionActive()) return
  gdb.patchMemoryCache(addr, data)
}

export async function writeMemory(addr: number, data: Uint8Array): Promise<boolean> {
  if (!gdb.sessionActive()) return false
  return gdb.writeMemory(addr, data)
}

/** Feed the guest ELF so thread-info + function symbols can be resolved. */
export function setKernelImage(elf: Uint8Array | null) {
  gdb.setKernelImage(elf)
}
