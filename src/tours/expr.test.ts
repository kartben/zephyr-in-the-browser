import { describe, expect, it } from 'vitest'
import { evalAddress, evalWatch, isKnownFormat, type TourTarget } from '@/tours/expr'

/**
 * A pretend guest: `led` at 0x2000 holding a pointer to a `struct device` at
 * 0x3000, whose first field points at the string "gpio@9030000".
 */
function target(pointerBytes: 4 | 8 = 4): TourTarget {
  const memory = new Map<number, Uint8Array>()
  const word = (value: number) => {
    const out = new Uint8Array(pointerBytes)
    for (let i = 0; i < pointerBytes; i++) out[i] = (value >>> (i * 8)) & 0xff
    return out
  }
  const put = (addr: number, bytes: Uint8Array) => {
    bytes.forEach((b, i) => memory.set(addr + i, new Uint8Array([b])))
  }
  put(0x2000, word(0x3000)) // led.port
  put(0x2000 + pointerBytes, new Uint8Array([4, 0, 0x01, 0x00])) // pin 4, flags 1
  put(0x3000, word(0x4000)) // device.name
  put(0x4000, new Uint8Array([...[...'gpio@9030000'].map((c) => c.charCodeAt(0)), 0]))

  return {
    pointerBytes,
    symbol: (name) => (name === 'led' ? 0x2000 : name === 'main' ? 0x8100 : null),
    register: (name) => (name === 'pc' ? 0x8123 : null),
    async read(addr, length) {
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        const byte = memory.get(addr + i)
        if (!byte) return null
        out[i] = byte[0]!
      }
      return out
    },
    label: (addr) => (addr >= 0x8100 && addr < 0x8200 ? `main+0x${(addr - 0x8100).toString(16)}` : null),
  }
}

describe('evalAddress', () => {
  it('resolves symbols to where they live, not what they hold', async () => {
    expect(await evalAddress('led', target())).toBe(0x2000)
  })

  it('follows a pointer with `*`', async () => {
    expect(await evalAddress('*led', target())).toBe(0x3000)
    expect(await evalAddress('**led', target())).toBe(0x4000)
  })

  it('does arithmetic, with parens and registers', async () => {
    const t = target()
    expect(await evalAddress('led+4', t)).toBe(0x2004)
    expect(await evalAddress('*(led + 0)', t)).toBe(0x3000)
    expect(await evalAddress('$pc - 0x23', t)).toBe(0x8100)
  })

  it('scales `p` by the guest pointer width', async () => {
    expect(await evalAddress('led+1p', target(4))).toBe(0x2004)
    expect(await evalAddress('led+1p', target(8))).toBe(0x2008)
    expect(await evalAddress('led+2p+2', target(8))).toBe(0x2012)
  })

  it('refuses what it cannot resolve', async () => {
    await expect(evalAddress('nope', target())).rejects.toThrow('no symbol')
    await expect(evalAddress('$sp', target())).rejects.toThrow('no register')
    await expect(evalAddress('led +', target())).rejects.toThrow()
    await expect(evalAddress('led & 3', target())).rejects.toThrow()
  })
})

describe('evalWatch', () => {
  it('reads an integer at the address the expression names', async () => {
    expect(await evalWatch('led+1p', 'u8', target())).toMatchObject({ text: '4', ok: true })
    expect(await evalWatch('led+1p+2', 'u16', target())).toMatchObject({ text: '1', ok: true })
  })

  it('shows large values in decimal and hex', async () => {
    expect((await evalWatch('led', 'u32', target())).text).toBe('12288 · 0x3000')
  })

  it('reads a C string through two pointers', async () => {
    expect(await evalWatch('**led', 'string', target())).toMatchObject({
      text: '"gpio@9030000"',
      ok: true,
    })
  })

  it('labels an address instead of reading it', async () => {
    expect(await evalWatch('$pc', 'code', target())).toMatchObject({
      text: 'main+0x23',
      detail: '0x8123',
    })
    expect(await evalWatch('led', 'addr', target())).toMatchObject({ text: '0x2000' })
  })

  it('gives back the value itself for `dec`, without reading through it', async () => {
    // An argument register holding a stack size is a number, not a place: `u32`
    // would go looking for memory at 2048 and report it as unreadable.
    expect(await evalWatch('2048', 'dec', target())).toMatchObject({
      text: '2048 · 0x800',
      ok: true,
    })
    expect((await evalWatch('4', 'dec', target())).text).toBe('4')
    expect((await evalWatch('2048', 'u32', target())).ok).toBe(false)
  })

  it('follows a pointer for `ptr` and hexdumps for `bytes:N`', async () => {
    expect((await evalWatch('led', 'ptr', target())).text).toBe('0x3000')
    expect((await evalWatch('led+1p', 'bytes:4', target())).text).toBe('04 00 01 00')
  })

  it('turns a failure into a value rather than an exception', async () => {
    expect(await evalWatch('nope', 'u32', target())).toMatchObject({ ok: false })
    expect(await evalWatch('0x9999', 'u32', target())).toMatchObject({
      ok: false,
      text: 'unreadable',
    })
    expect(await evalWatch('led', 'u37', target())).toMatchObject({ ok: false })
  })
})

describe('isKnownFormat', () => {
  it('knows the vocabulary, including the counted hexdump', () => {
    expect(isKnownFormat('u8')).toBe(true)
    expect(isKnownFormat('string')).toBe(true)
    expect(isKnownFormat('bytes:12')).toBe(true)
    expect(isKnownFormat('bytes')).toBe(false)
    expect(isKnownFormat('u37')).toBe(false)
  })
})
