import { describe, expect, it } from 'vitest'
import { ThreadInfoOffset, type ThreadInfo } from '@/debug/kernel/meta'
import { listThreads } from '@/debug/kernel/threads'
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

describe('listThreads', () => {
  it('walks _kernel.threads like OpenOCD', async () => {
    const info: ThreadInfo = {
      kernel: 0x1000,
      ptrBytes: 4,
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
})
