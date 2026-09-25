import { describe, expect, it } from 'vitest'

import { objectAt } from './objectLinks'
import type { ObjectCoreSnapshot, ZephyrKernelObject } from '@/debug/kernel/objectCores'

const object = (addr: number, name: string, size: number | null): ZephyrKernelObject => ({
  addr,
  coreAddr: addr + 0x18,
  typeAddr: 0,
  typeId: 0,
  typeCode: 'SEM4',
  typeName: 'Semaphores',
  name,
  size,
  capacity: null,
  staticObject: true,
  fields: [],
  stats: null,
})

const snapshot: ObjectCoreSnapshot = {
  types: [
    {
      addr: 1,
      id: 1,
      code: 'SEM4',
      name: 'Semaphores',
      objectSize: 48,
      objects: [object(0x1000, 'outer', 0x100), object(0x1040, 'inner', null)],
    },
  ],
  objectCount: 2,
  statsCount: 0,
  truncated: false,
}

describe('objectAt', () => {
  it('finds an object by its address', () => {
    expect(objectAt(snapshot, 0x1040)?.name).toBe('inner')
  })

  it("finds the tightest object around a member's address", () => {
    // A k_fifo's wait_q is not its first member: pended_on lands inside it.
    expect(objectAt(snapshot, 0x1050)?.name).toBe('inner')
    expect(objectAt(snapshot, 0x1010)?.name).toBe('outer')
  })

  it('says nothing for an address no object owns', () => {
    expect(objectAt(snapshot, 0x2000)).toBeNull()
    expect(objectAt(null, 0x1000)).toBeNull()
  })
})
