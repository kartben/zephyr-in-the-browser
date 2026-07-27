/**
 * Single control plane for pause / step / registers.
 *
 * When a gdb RSP session is attached, run-control goes through the stub.
 * Otherwise fall back to the QMP monitor (Step 1). Annotations and the TopBar
 * both call this module so they cannot diverge.
 */

import * as gdb from '@/hostGdb'
import * as monitor from '@/hostMonitor'

export interface DebugSnapshot {
  /** Either bridge is present. */
  available: boolean
  /** gdbstub session is driving run-control. */
  gdb: boolean
  paused: boolean
  pc: string | null
  summary: string | null
  registers: string | null
  registersLoading: boolean
  canStep: boolean
  breakpoints: { addr: number; addrHex: string }[]
  memory: { addr: number; hex: string } | null
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
      summary: g.summary,
      registers: g.registers,
      registersLoading: g.registersLoading,
      canStep: true,
      breakpoints: g.breakpoints,
      memory: g.memory,
    }
  }
  return {
    available: m.available,
    gdb: false,
    paused: m.paused,
    pc: m.pc,
    summary: m.summary,
    registers: m.registers,
    registersLoading: m.registersLoading,
    canStep: false,
    breakpoints: [],
    memory: null,
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
