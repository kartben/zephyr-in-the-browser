/**
 * A {@link HexBacked} facade over the debugger's last memory peek.
 *
 * Keeps one stable buffer so {@link HexView}'s change-flash can diff across
 * pause → resume → pause re-reads of the same window. Edits go out through
 * GDB `M` packets via {@link writeMemory}.
 */

import type { HexBacked } from '@/virtio/devices/memory/model'
import { hexToBytes } from '@/debug/gdb/rspCodec'
import * as debug from '@/debug/control'

export interface DebugMemoryChip extends HexBacked {
  readonly baseAddr: number
  /** Replace contents in place when the peek window is the same size. */
  apply(hex: string): void
}

export function createDebugMemoryChip(baseAddr: number, hex: string): DebugMemoryChip {
  let memory = hexToBytes(hex)
  let ver = 1
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const fn of listeners) fn()
  }

  const chip: DebugMemoryChip = {
    get memory() {
      return memory
    },
    get baseAddr() {
      return baseAddr
    },
    decl: {
      get size() {
        return memory.length
      },
    },
    version: () => ver,
    pointer: () => -1,
    erase() {
      /* guest RAM has no erase */
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    apply(nextHex: string) {
      const next = hexToBytes(nextHex)
      if (next.length !== memory.length) {
        memory = next
        ver++
        notify()
        return
      }
      let changed = false
      for (let i = 0; i < next.length; i++) {
        if (memory[i] !== next[i]) {
          changed = true
          break
        }
      }
      if (!changed) return
      memory.set(next)
      ver++
      notify()
    },
    poke(offset, value) {
      if (offset < 0 || offset >= memory.length) return
      if (!debug.getSnapshot().paused) return
      const next = value & 0xff
      if (memory[offset] === next) return
      memory[offset] = next
      ver++
      notify()
      const abs = baseAddr + offset
      const written = Uint8Array.of(next)
      debug.patchMemoryCache(abs, written)
      void debug.writeMemory(abs, written).then((ok) => {
        if (!ok) void debug.readMemory(baseAddr, memory.length)
      })
    },
  }

  return chip
}
