/**
 * Hover values for the stopped guest.
 *
 * The DWARF engine knows the image; this module knows the machine. It turns
 * the debugger's last stop (the PC, the register dump, memory through the
 * stub) into what the engine reads, and keeps the memory it fetched until the
 * guest moves, because on the QEMU path every read is a gdbstub round trip.
 *
 * Everything is evaluated in the frame the guest is stopped in, as VS Code
 * does: a hover asks about the text under the pointer at the stop, whatever
 * line it is on.
 */

import { DwarfEngine, type FrameTarget } from '@/debug/dwarf/engine'
import { evaluateExpression, EvalError, parseExpression } from '@/debug/dwarf/cexpr'
import { ValueReader, type Val, type ValueTarget, type ValueView } from '@/debug/dwarf/values'
import { formatSymbol, resolveDataSymbol, resolveSymbol, type SymbolIndex } from '@/debug/elfSymbols'
import { codeAddr, RISCV_ABI_NAMES, type GdbArch } from '@/debug/gdb/regs'
import { organizeRegisters } from '@/debug/registerModel'

/** A stopped machine, as the debugger last published it. */
export interface StopState {
  elf: Uint8Array
  pc: number
  /** The `NAME=value` register dump. */
  registers: string
  arch: GdbArch
  symbols: SymbolIndex | null
  read(addr: number, length: number): Promise<Uint8Array | null>
}

/** What one stop can answer. Build one per stop: it caches that stop's memory. */
export interface Inspector {
  /**
   * A hovered expression's value, or null when it does not evaluate: VS Code
   * shows no hover then (a macro, a type, a function, a word in a comment).
   */
  evaluate(text: string): Promise<ValueView | null>
}

/** Bytes per cached read: one gdbstub packet covers a small struct. */
const BLOCK = 64

export function createInspector(stop: StopState): Inspector | null {
  const engine = DwarfEngine.forElf(stop.elf)
  if (!engine) return null
  const regs = registerFile(stop.registers, stop.arch)
  const read = cachedReader(stop.read)
  const frameTarget: FrameTarget = { pc: stop.pc, reg: regs, read }
  const valueTarget: ValueTarget = {
    read,
    reg: regs,
    label: (addr) =>
      formatSymbol(resolveDataSymbol(stop.symbols, addr) ?? resolveSymbol(stop.symbols, addr)),
    codeAddress: (addr) => codeAddr(stop.arch, addr),
  }
  const reader = new ValueReader(engine, valueTarget)
  const frames = engine.framesAt(stop.pc)
  const frame = frames[0] ?? null
  const unit = engine.info.unitForPc(stop.pc)

  return {
    async evaluate(text) {
      const expr = parseExpression(text)
      if (!expr) return null
      try {
        const val = await evaluateExpression(
          expr,
          {
            reader,
            types: engine.types,
            pointerSize: engine.addrSize as 4 | 8,
            lookup: async (name): Promise<Val | null> => {
              const v = engine.resolve(name, frame, unit)
              if (!v) return null
              return { name, type: engine.types.typeOf(v.die), loc: await engine.locate(v, frameTarget) }
            },
          },
          text,
        )
        return await reader.view(val)
      } catch (err) {
        if (err instanceof EvalError) return null
        throw err
      }
    },
  }
}

/** DWARF register numbers in the names the register dump uses. */
function dwarfRegisterNames(arch: GdbArch): readonly string[] {
  switch (arch) {
    case 'arm':
      return [...Array.from({ length: 13 }, (_, i) => `r${i}`), 'sp', 'lr', 'pc']
    case 'aarch64':
      // The dump calls x30 LR, as the register grid shows it.
      return [...Array.from({ length: 30 }, (_, i) => `x${i}`), 'lr', 'sp']
    case 'riscv32':
      return RISCV_ABI_NAMES
    case 'xtensa':
      // a0..a15 of the current window: the decoder has already rotated them.
      return Array.from({ length: 16 }, (_, i) => `a${i}`)
  }
}

/**
 * Register values by DWARF number. Read from the dump as bigints, since
 * AArch64 registers do not fit a JS number.
 */
function registerFile(dump: string, arch: GdbArch): (n: number) => bigint | null {
  const byName = new Map<string, bigint>()
  const layout = organizeRegisters(dump)
  for (const entry of [...layout.featured, ...layout.general, ...layout.status]) {
    let value: bigint
    try {
      value = BigInt(`0x${entry.value}`)
    } catch {
      continue
    }
    const name = entry.name.toLowerCase()
    byName.set(name, value)
    // R03 → r3, X00 → x0, A07 → a7.
    const padded = /^([a-z]+)0*(\d+)$/.exec(name)
    if (padded) byName.set(`${padded[1]}${padded[2]}`, value)
  }
  const names = dwarfRegisterNames(arch)
  return (n) => {
    const name = names[n]
    if (name === 'zero') return 0n
    return name === undefined ? null : (byName.get(name) ?? null)
  }
}

/** Reads in aligned blocks, kept for the life of the stop. */
function cachedReader(
  read: (addr: number, length: number) => Promise<Uint8Array | null>,
): (addr: number, length: number) => Promise<Uint8Array | null> {
  const blocks = new Map<number, Promise<Uint8Array | null>>()
  const block = (base: number) => {
    let pending = blocks.get(base)
    if (!pending) {
      pending = read(base, BLOCK)
      blocks.set(base, pending)
    }
    return pending
  }
  return async (addr, length) => {
    if (length <= 0) return new Uint8Array(0)
    const first = Math.floor(addr / BLOCK) * BLOCK
    const last = Math.floor((addr + length - 1) / BLOCK) * BLOCK
    const out = new Uint8Array(length)
    for (let base = first; base <= last; base += BLOCK) {
      const bytes = await block(base)
      // A block that runs off the end of RAM fails as a whole; the bytes
      // asked for may still be readable on their own.
      if (!bytes || bytes.length < BLOCK) return read(addr, length)
      const from = Math.max(addr, base)
      const to = Math.min(addr + length, base + BLOCK)
      out.set(bytes.subarray(from - base, to - base), from - addr)
    }
    return out
  }
}
