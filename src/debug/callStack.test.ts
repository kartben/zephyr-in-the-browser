import { describe, expect, it } from 'vitest'
import {
  MAX_FRAMES,
  describeMethod,
  unwindStack,
  type UnwindOptions,
} from '@/debug/callStack'
import type { ResolvedSymbol } from '@/debug/elfSymbols'

/**
 * A tiny pretend image: three functions in .text, and a stack we lay out byte
 * by byte. Both of the unwinder's inputs are injected, so these tests pin the
 * decisions it makes — which candidates count as callers, when a chain is
 * abandoned — without a guest.
 */
const FUNCS = [
  { name: 'main', addr: 0x8_0000, size: 0x100 },
  { name: 'work', addr: 0x8_0100, size: 0x100 },
  { name: 'leaf', addr: 0x8_0200, size: 0x100 },
]

function resolve(addr: number): ResolvedSymbol | null {
  for (const f of FUNCS) {
    if (addr >= f.addr && addr < f.addr + f.size) {
      return { name: f.name, addr: f.addr, offset: addr - f.addr }
    }
  }
  return null
}

/** Writable guest memory keyed by address, read back at any alignment. */
function memory(width: 4 | 8) {
  const bytes = new Map<number, number>()

  const writeWord = (addr: number, value: number) => {
    let v = value
    for (let i = 0; i < width; i++) {
      bytes.set(addr + i, v % 256)
      v = Math.floor(v / 256)
    }
  }

  const read: UnwindOptions['read'] = async (addr, length) => {
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i++) out[i] = bytes.get(addr + i) ?? 0
    return out
  }

  return { writeWord, read }
}

describe('unwindStack', () => {
  it('follows the aarch64 frame-pointer chain and labels the frames', async () => {
    const mem = memory(8)
    const sp = 0x4000_0000
    // Two frame records: leaf → work → main. Each holds {caller fp, return}.
    mem.writeWord(sp + 0x20, sp + 0x40) // caller fp
    mem.writeWord(sp + 0x28, 0x8_0140) // return into work
    mem.writeWord(sp + 0x40, 0) // chain ends
    mem.writeWord(sp + 0x48, 0x8_0050) // return into main

    const result = await unwindStack({
      arch: 'aarch64',
      pc: 0x8_0210,
      sp,
      fp: sp + 0x20,
      lr: 0,
      read: mem.read,
      resolve,
    })

    expect(result.method).toBe('fp')
    expect(result.frames.map((f) => f.label)).toEqual(['leaf+0x10', 'work+0x40', 'main+0x50'])
    expect(result.frames.map((f) => f.origin)).toEqual(['pc', 'fp', 'fp'])
    // Deeper frames point at the stack slot they were read from, for a peek.
    expect(result.frames[1]!.slot).toBe(sp + 0x28)
  })

  it('abandons the chain when a record does not hold a return address', async () => {
    const mem = memory(8)
    const sp = 0x4000_0000
    mem.writeWord(sp + 0x20, sp + 0x40)
    mem.writeWord(sp + 0x28, 0x8_0140) // good
    mem.writeWord(sp + 0x40, sp + 0x60)
    mem.writeWord(sp + 0x48, 0xdead_0000) // not code — stop here

    const result = await unwindStack({
      arch: 'aarch64',
      pc: 0x8_0210,
      sp,
      fp: sp + 0x20,
      read: mem.read,
      resolve,
      scanBytes: 0,
    })

    expect(result.frames.map((f) => f.label)).toEqual(['leaf+0x10', 'work+0x40'])
  })

  it('uses the link register when there is no frame record', async () => {
    const mem = memory(8)
    const result = await unwindStack({
      arch: 'aarch64',
      pc: 0x8_0210,
      sp: 0x4000_0000,
      fp: 0, // omitted frame pointers
      lr: 0x8_0140,
      read: mem.read,
      resolve,
      scanBytes: 0,
    })

    expect(result.frames.map((f) => f.origin)).toEqual(['pc', 'lr'])
    expect(result.frames[1]!.label).toBe('work+0x40')
  })

  it('scans the stack for plausible callers, skipping function starts', async () => {
    const mem = memory(8)
    const sp = 0x4000_0000
    mem.writeWord(sp + 0x00, 0x1234) // not code
    mem.writeWord(sp + 0x08, 0x8_0100) // a function *start* — a pointer, not a caller
    mem.writeWord(sp + 0x10, 0x8_0144) // return into work
    mem.writeWord(sp + 0x18, 0x8_0144) // the same address spilled twice
    mem.writeWord(sp + 0x20, 0x8_0058) // return into main

    const result = await unwindStack({
      arch: 'aarch64',
      pc: 0x8_0210,
      sp,
      fp: 0,
      lr: 0,
      read: mem.read,
      resolve,
      scanBytes: 0x28,
    })

    expect(result.method).toBe('scan')
    expect(result.frames.map((f) => f.label)).toEqual(['leaf+0x10', 'work+0x44', 'main+0x58'])
    expect(result.frames[1]!.slot).toBe(sp + 0x10)
  })

  it('does not scan past the end of the thread stack', async () => {
    const mem = memory(8)
    const sp = 0x4000_0000
    mem.writeWord(sp + 0x08, 0x8_0144) // inside the stack
    mem.writeWord(sp + 0x18, 0x8_0058) // past its end — belongs to whatever is next

    const result = await unwindStack({
      arch: 'aarch64',
      pc: 0x8_0210,
      sp,
      fp: 0,
      stackStart: sp - 0x100,
      stackSize: 0x110, // ends at sp + 0x10
      read: mem.read,
      resolve,
    })

    expect(result.frames.map((f) => f.label)).toEqual(['leaf+0x10', 'work+0x44'])
  })

  it('clears the Thumb bit so ARM return addresses resolve', async () => {
    const mem = memory(4)
    const sp = 0x2000_0000
    mem.writeWord(sp + 0x04, 0x8_0145) // odd: Thumb-mode return address

    const result = await unwindStack({
      arch: 'arm',
      pc: 0x8_0211,
      sp,
      fp: 0,
      read: mem.read,
      resolve,
      scanBytes: 0x10,
    })

    expect(result.frames.map((f) => f.label)).toEqual(['leaf+0x10', 'work+0x44'])
  })

  it('stops at the frame cap and says the stack was truncated', async () => {
    const mem = memory(8)
    const sp = 0x4000_0000
    for (let i = 0; i < MAX_FRAMES + 4; i++) {
      // Distinct addresses inside work so none are deduped as a repeat.
      mem.writeWord(sp + i * 8, 0x8_0104 + i * 4)
    }

    const result = await unwindStack({
      arch: 'aarch64',
      pc: 0x8_0210,
      sp,
      fp: 0,
      read: mem.read,
      resolve,
    })

    expect(result.frames).toHaveLength(MAX_FRAMES)
    expect(result.truncated).toBe(true)
  })

  it('returns only the PC frame when nothing can be recovered', async () => {
    const mem = memory(8)
    const result = await unwindStack({
      arch: 'aarch64',
      pc: 0x8_0210,
      sp: 0x4000_0000,
      fp: 0,
      lr: 0,
      read: mem.read,
      resolve,
    })

    expect(result.frames.map((f) => f.origin)).toEqual(['pc'])
    expect(describeMethod(result.method)).toBeNull()
  })

  it('walks a parked thread from its saved SP alone', async () => {
    const mem = memory(8)
    const sp = 0x4000_0000
    mem.writeWord(sp + 0x10, 0x8_0148)

    const result = await unwindStack({
      arch: 'aarch64',
      pc: null, // no PC for a thread that is not running
      sp,
      read: mem.read,
      resolve,
      scanBytes: 0x40,
    })

    expect(result.frames.map((f) => f.label)).toEqual(['work+0x48'])
    expect(result.frames[0]!.origin).toBe('scan')
  })
})
