import { describe, expect, it } from 'vitest'

import { buildAddressMap, formatTarget } from './addressMap'
import type { ObjectCoreSnapshot } from './kernel/objectCores'
import type { SymbolIndex } from './elfSymbols'

function objects(): ObjectCoreSnapshot {
  return {
    objectCount: 2,
    statsCount: 0,
    truncated: false,
    types: [
      {
        addr: 0x0800_4c10,
        id: 1,
        code: 'MSGQ',
        name: 'Message queues',
        objectSize: 40,
        objects: [
          {
            addr: 0x2000_1a40,
            coreAddr: 0x2000_1a64,
            typeAddr: 0x0800_4c10,
            typeId: 1,
            typeCode: 'MSGQ',
            typeName: 'Message queues',
            name: 'uart_msgq',
            size: 40,
            capacity: 8,
            staticObject: true,
            fields: [{ label: 'Used messages', value: '8' }],
            stats: null,
          },
        ],
      },
      {
        addr: 0x0800_4c40,
        id: 2,
        code: 'THRD',
        name: 'Threads',
        objectSize: 128,
        objects: [
          {
            addr: 0x2000_0c10,
            coreAddr: 0x2000_0c50,
            typeAddr: 0x0800_4c40,
            typeId: 2,
            typeCode: 'THRD',
            typeName: 'Threads',
            name: 'blink_thread',
            size: 128,
            capacity: null,
            staticObject: true,
            fields: [],
            stats: null,
          },
        ],
      },
    ],
  }
}

const symbols: SymbolIndex = {
  byAddr: [{ name: 'blink_entry', addr: 0x0800_1d40, size: 0x40 }],
  byName: [{ name: 'blink_entry', addr: 0x0800_1d40, size: 0x40 }],
  objects: new Map([
    // Deliberately spans the TCB: object core must win over the data symbol.
    ['blink_thread', { name: 'blink_thread', addr: 0x2000_0c10, size: 128 }],
    ['uart_msgq_buf', { name: 'uart_msgq_buf', addr: 0x2000_1b00, size: 0x80 }],
  ]),
}

const stacks = [{ name: 'blink_stack', addr: 0x2000_2b40, size: 0x400 }]

const map = buildAddressMap({ objects: objects(), stacks, symbols })

describe('buildAddressMap', () => {
  it('names a kernel object exactly, with its type', () => {
    const hit = map.resolve(0x2000_1a40)
    expect(hit).toMatchObject({
      kind: 'object',
      name: 'uart_msgq',
      offset: 0,
      typeCode: 'MSGQ',
      size: 40,
    })
    expect(formatTarget(hit!)).toBe('uart_msgq')
  })

  it('names an address inside an object with its offset', () => {
    const hit = map.resolve(0x2000_0c18)
    expect(hit).toMatchObject({ kind: 'object', name: 'blink_thread', offset: 8 })
    expect(formatTarget(hit!)).toBe('blink_thread+0x8')
  })

  it('prefers the object core answer over the plain data symbol', () => {
    expect(map.resolve(0x2000_0c10)?.kind).toBe('object')
    expect(map.resolve(0x2000_0c10)?.typeCode).toBe('THRD')
  })

  it('calls out the embedded object core member', () => {
    expect(map.resolve(0x2000_1a64)).toMatchObject({
      kind: 'objectCore',
      name: 'uart_msgq',
      offset: 0,
    })
  })

  it('resolves stacks, data symbols and functions', () => {
    expect(map.resolve(0x2000_2e80)).toMatchObject({
      kind: 'stack',
      name: 'blink_stack',
      offset: 0x340,
    })
    expect(map.resolve(0x2000_1b20)).toMatchObject({ kind: 'data', name: 'uart_msgq_buf' })
    expect(map.resolve(0x0800_1d44)).toMatchObject({ kind: 'code', name: 'blink_entry', offset: 4 })
  })

  it('returns null for addresses nothing owns', () => {
    expect(map.resolve(0x3000_0000)).toBeNull()
    // One past the end of the stack region.
    expect(map.resolve(0x2000_2f40)).toBeNull()
  })

  it('is empty without an image or objects', () => {
    expect(buildAddressMap({ objects: null, stacks: [], symbols: null }).empty).toBe(true)
    expect(buildAddressMap({ objects: null, stacks: [], symbols: null }).resolve(0x2000_1a40)).toBeNull()
  })
})
