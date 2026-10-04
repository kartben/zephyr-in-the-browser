import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { DebugSnapshot } from '@/debug/control'
import type { ZephyrKernelObject } from '@/debug/kernel/objectCores'
import type { MsgqRingSnapshot } from '@/debug/kernel/msgqRing'
import type { TourObjects as TourObjectsSpec } from '@/tours/store'

vi.mock('@/lib/debugUi', () => ({ focusDebugObject: () => {} }))

const { TourObjects } = await import('./TourObjects')

/**
 * Where the ring goes on an objects card: in place of the focused queue's row,
 * and nowhere else. Without one (no DWARF for the pointers, or `view: list`)
 * the card is exactly what it was before rings existed.
 */

const BUFFER = 0x4006_1670

function msgq(name: string, addr: number): ZephyrKernelObject {
  return {
    addr,
    coreAddr: addr + 72,
    typeAddr: 0x4000_0800,
    typeId: 0x4d534751,
    typeCode: 'MSGQ',
    typeName: 'Message queues',
    name,
    size: 96,
    capacity: 10,
    staticObject: true,
    fields: [
      { label: 'Message size', value: '1' },
      { label: 'Used messages', value: '3' },
      { label: 'Capacity', value: '10' },
    ],
    stats: null,
  }
}

const QUEUE = msgq('my_msgq', 0x4000_e160)
const OTHER = msgq('log_msgq', 0x4000_f000)

const snap = {
  objectCores: true,
  objects: {
    types: [
      {
        addr: 0x4000_0800,
        id: 0x4d534751,
        code: 'MSGQ',
        name: 'Message queues',
        objectSize: 96,
        objects: [QUEUE, OTHER],
      },
    ],
    objectCount: 2,
    statsCount: 0,
    truncated: false,
  },
  objectsError: null,
  threads: [],
} as unknown as DebugSnapshot

const RING: MsgqRingSnapshot = {
  msgSize: 1,
  maxMsgs: 10,
  used: 3,
  bufferStart: BUFFER,
  bufferEnd: BUFFER + 10,
  readPtr: BUFFER + 9,
  writePtr: BUFFER + 2,
  bytes: new TextEncoder().encode('01\0\0\0\0\0\0\0A'),
}

function render(spec: Partial<TourObjectsSpec>) {
  const full: TourObjectsSpec = { types: ['MSGQ'], focus: QUEUE.addr, ring: null, ...spec }
  return renderToStaticMarkup(<TourObjects spec={full} snap={snap} live />)
}

describe('TourObjects with a ring', () => {
  it('draws the focused queue as its ring, in place of its row', () => {
    const html = render({ ring: RING })
    expect(html).toContain('aria-label="my_msgq ring buffer"')
    expect(html).toContain('3 of 10 used, 1 byte per message')
    // The other queue keeps its row, and only it still lists its fields.
    expect(html.match(/Used messages/g)).toHaveLength(1)
    expect(html).toContain('log_msgq')
    expect(html).not.toContain('log_msgq ring buffer')
  })

  it('shows the plain rows when there is no ring', () => {
    const html = render({ ring: null })
    expect(html).not.toContain('ring buffer')
    expect(html.match(/Used messages/g)).toHaveLength(2)
  })

  it('draws a ring only under the queue it was read from', () => {
    const html = render({ ring: RING, focus: 0x4000_1234 })
    expect(html).not.toContain('ring buffer')
  })
})
