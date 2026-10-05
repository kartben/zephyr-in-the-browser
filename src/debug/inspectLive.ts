/**
 * The inspector for the debugger's current stop.
 *
 * One {@link Inspector} per stop, so memory read for one hover is reused by the
 * next, and none of it outlives the stop: the guest only has to run for a
 * moment (a Continue, a Step) for every cached byte to be stale.
 */

import * as debug from '@/debug/control'
import { createInspector, type Inspector } from '@/debug/inspect'
import * as hostGdb from '@/hostGdb'

let current: { key: string; inspector: Inspector | null } | null = null
/** Counts the times the guest has run, so a re-hit at the same PC is a new stop. */
let runs = 0
let watching = false

function watch(): void {
  if (watching) return
  watching = true
  debug.subscribe(() => {
    if (!debug.getSnapshot().paused) {
      runs++
      current = null
    }
  })
}

/**
 * The inspector for the stop the debugger has published, or null while the
 * guest runs, before its registers are in, or for an image with no DWARF.
 */
export function stopInspector(): Inspector | null {
  watch()
  const snap = debug.getSnapshot()
  if (!snap.gdb || !snap.paused || snap.registersLoading) return null
  if (!snap.pc || !snap.registers || !snap.regArch) return null
  const elf = hostGdb.getKernelElf()
  if (!elf) return null
  const key = `${runs}|${snap.pc}|${snap.registers}`
  if (current?.key === key) return current.inspector
  const inspector = createInspector({
    elf,
    pc: Number.parseInt(snap.pc, 16),
    registers: snap.registers,
    arch: snap.regArch,
    symbols: hostGdb.getSymbolIndex(),
    read: (addr, length) => debug.readMemoryRaw(addr, length),
  })
  current = { key, inspector }
  return inspector
}
