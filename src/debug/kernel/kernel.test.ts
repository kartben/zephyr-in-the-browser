import { describe, expect, it } from 'vitest'
import { ThreadInfoOffset, type ThreadInfo } from '@/debug/kernel/meta'
import {
  formatStackSize,
  listThreads,
  threadStateLabel,
} from '@/debug/kernel/threads'
import { findStackRegion } from '@/debug/elfStacks'
import { compactHex, isInactiveRegValue } from '@/debug/hexFormat'

describe('compactHex', () => {
  it('strips leading zeros', () => {
    expect(compactHex('000000004003b018')).toBe('4003b018')
    expect(compactHex('0000000000000040')).toBe('40')
    expect(compactHex('aaaaaaaaaaaaaaaa')).toBe('aaaaaaaaaaaaaaaa')
  })

  it('dims zero and stack-paint values', () => {
    expect(isInactiveRegValue('00000000')).toBe(true)
    expect(isInactiveRegValue('aaaaaaaaaaaaaaaa')).toBe(true)
    expect(isInactiveRegValue('4003b018')).toBe(false)
  })
})

describe('thread labels', () => {
  it('formats stack sizes', () => {
    expect(formatStackSize(512)).toBe('512 B')
    expect(formatStackSize(2048)).toBe('2 KiB')
    expect(formatStackSize(1536)).toBe('1.5 KiB')
  })

  it('labels thread state', () => {
    expect(threadStateLabel(0, true)).toBe('running')
    expect(threadStateLabel(0x10, false)).toBe('suspended')
    expect(threadStateLabel(0x02, false)).toBe('pending')
    expect(threadStateLabel(0x80, false)).toBe('ready')
  })
})

describe('findStackRegion', () => {
  it('picks the tightest containing stack object', () => {
    const regions = [
      { name: 'big_stack', addr: 0x20000000, size: 8192 },
      { name: 'main_stack', addr: 0x20001000, size: 2048 },
    ]
    expect(findStackRegion(regions, 0x20001400)?.name).toBe('main_stack')
    expect(findStackRegion(regions, 0x20000080)?.name).toBe('big_stack')
    expect(findStackRegion(regions, 0x30000000)).toBeNull()
  })
})

describe('listThreads', () => {
  it('walks _kernel.threads like OpenOCD', async () => {
    const info: ThreadInfo = {
      kernel: 0x1000,
      ptrBytes: 4,
      stackInfoOff: null,
      offsets: [
        1, // VERSION
        0x64, // K_CURR_THREAD
        0, // K_THREADS
        0x28, // T_ENTRY
        4, // T_NEXT
        0x20, // T_STATE
        0x21, // T_USER_OPTIONS
        0x22, // T_PRIO
        0xffffffff, // T_STACK_PTR
        8, // T_NAME
      ],
    }
    expect(info.offsets[ThreadInfoOffset.K_THREADS]).toBe(0)

    const mem = new Map<number, Uint8Array>()
    const set = (addr: number, bytes: number[]) => mem.set(addr, Uint8Array.from(bytes))
    const ptr = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]

    set(0x1000, ptr(0x2000))
    set(0x1000 + 0x64, ptr(0x2000))
    set(0x2000 + 4, ptr(0x3000))
    set(0x2000 + 8, [...'idle'].map((c) => c.charCodeAt(0)).concat([0]))
    set(0x2000 + 0x22, [0])
    set(0x2000 + 0x20, [0])
    set(0x2000 + 0x28, ptr(0xaaaa))
    set(0x3000 + 4, ptr(0))
    set(0x3000 + 8, [...'main'].map((c) => c.charCodeAt(0)).concat([0]))
    set(0x3000 + 0x22, [1])
    set(0x3000 + 0x20, [0])
    set(0x3000 + 0x28, ptr(0xbbbb))

    const read = async (addr: number, length: number) => {
      const out = new Uint8Array(length)
      for (const [base, chunk] of mem) {
        for (let i = 0; i < chunk.length; i++) {
          const a = base + i
          if (a >= addr && a < addr + length) out[a - addr] = chunk[i]!
        }
      }
      return out
    }

    const threads = await listThreads(info, read)
    expect(threads).toHaveLength(2)
    expect(threads[0]).toMatchObject({ name: 'idle', current: true, addr: 0x2000, prio: 0 })
    expect(threads[1]).toMatchObject({ name: 'main', current: false, addr: 0x3000, prio: 1 })
  })

  it('matches SP to ELF stack regions for size', async () => {
    const info: ThreadInfo = {
      kernel: 0x1000,
      ptrBytes: 4,
      stackInfoOff: null,
      offsets: [
        1,
        0x64,
        0,
        0x28,
        4,
        0x20,
        0x21,
        0x22,
        0x30, // T_STACK_PTR — location of saved SP inside TCB
        8,
      ],
    }
    const mem = new Map<number, Uint8Array>()
    const set = (addr: number, bytes: number[]) => mem.set(addr, Uint8Array.from(bytes))
    const ptr = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]

    set(0x1000, ptr(0x2000))
    set(0x1000 + 0x64, ptr(0x2000))
    set(0x2000 + 4, ptr(0))
    set(0x2000 + 8, [...'main'].map((c) => c.charCodeAt(0)).concat([0]))
    set(0x2000 + 0x22, [0])
    set(0x2000 + 0x20, [0x80]) // ready
    set(0x2000 + 0x28, ptr(0xbbbb))
    set(0x2000 + 0x30, ptr(0x20001800)) // SP inside main_stack

    const read = async (addr: number, length: number) => {
      const out = new Uint8Array(length)
      for (const [base, chunk] of mem) {
        for (let i = 0; i < chunk.length; i++) {
          const a = base + i
          if (a >= addr && a < addr + length) out[a - addr] = chunk[i]!
        }
      }
      return out
    }

    const threads = await listThreads(info, read, {
      stacks: [{ name: 'main_stack', addr: 0x20001000, size: 2048 }],
    })
    expect(threads[0]).toMatchObject({
      name: 'main',
      sp: 0x20001800,
      stackStart: 0x20001000,
      stackSize: 2048,
    })
  })
})
