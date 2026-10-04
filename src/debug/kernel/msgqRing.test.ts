import { describe, expect, it } from 'vitest'
import {
  isRing,
  ringSlots,
  slotBytes,
  slotOf,
  type MsgqRing,
  type RingSlot,
} from '@/debug/kernel/msgqRing'

const BASE = 0x4006_1670

/** A ring of `maxMsgs` slots with R and W at the given slots. */
function ring(read: number, write: number, used: number, maxMsgs = 10, msgSize = 1): MsgqRing {
  return {
    msgSize,
    maxMsgs,
    used,
    bufferStart: BASE,
    bufferEnd: BASE + maxMsgs * msgSize,
    readPtr: BASE + read * msgSize,
    writePtr: BASE + write * msgSize,
  }
}

/*
 * The kernel's three moves, as kernel/msg_q.c makes them: a put writes at W and
 * moves it on, a get reads at R and moves it on, and a put_front steps R back
 * first. Both pointers wrap at buffer_end.
 */
function put(q: MsgqRing): MsgqRing {
  const next = q.writePtr + q.msgSize
  return { ...q, writePtr: next === q.bufferEnd ? q.bufferStart : next, used: q.used + 1 }
}

function putFront(q: MsgqRing): MsgqRing {
  const slot = (q.readPtr === q.bufferStart ? q.bufferEnd : q.readPtr) - q.msgSize
  return { ...q, readPtr: slot, used: q.used + 1 }
}

function get(q: MsgqRing): MsgqRing {
  const next = q.readPtr + q.msgSize
  return { ...q, readPtr: next === q.bufferEnd ? q.bufferStart : next, used: q.used - 1 }
}

/** The slots that hold a message, in the order they will be read. */
function readOrder(slots: RingSlot[]): number[] {
  return slots
    .filter((s) => s.occupied)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.index)
}

const at = (slots: RingSlot[], flag: 'isRead' | 'isWrite') =>
  slots.filter((s) => s[flag]).map((s) => s.index)

describe('ringSlots', () => {
  it('draws an empty queue with both pointers on one free slot', () => {
    const slots = ringSlots(ring(0, 0, 0))!
    expect(slots).toHaveLength(10)
    expect(slots.some((s) => s.occupied)).toBe(false)
    expect(at(slots, 'isRead')).toEqual([0])
    expect(at(slots, 'isWrite')).toEqual([0])
  })

  it('numbers a partly filled queue in read order, with W past the last message', () => {
    const slots = ringSlots(ring(0, 2, 2))!
    expect(readOrder(slots)).toEqual([0, 1])
    expect(slots.slice(0, 3).map((s) => s.order)).toEqual([1, 2, 0])
    expect(at(slots, 'isWrite')).toEqual([2])
  })

  it('follows the messages round the end of the buffer', () => {
    const slots = ringSlots(ring(8, 2, 4))!
    expect(readOrder(slots)).toEqual([8, 9, 0, 1])
    expect(slots.filter((s) => !s.occupied).map((s) => s.index)).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('puts a put_front at slot 0 into the last slot, first in line', () => {
    // '0' and '1' are queued from slot 0; the urgent 'A' wraps R back to 9.
    const q = putFront(put(put(ring(0, 0, 0))))
    expect(q.readPtr).toBe(BASE + 9)
    const slots = ringSlots(q)!
    expect(readOrder(slots)).toEqual([9, 0, 1])
    expect(slots[9]).toMatchObject({ occupied: true, order: 1, isRead: true, isWrite: false })
    expect(at(slots, 'isWrite')).toEqual([2])
  })

  it('reads 0 1 2 3 4 5 _ C B A after the msg_queue sample sends its nine', () => {
    // normal, normal, urgent, three times over: samples/kernel/msg_queue.
    let q = ring(0, 0, 0)
    for (let round = 0; round < 3; round++) q = putFront(put(put(q)))
    const slots = ringSlots(q)!
    expect(q.used).toBe(9)
    expect(slots.map((s) => (s.occupied ? s.index : '_'))).toEqual([0, 1, 2, 3, 4, 5, '_', 7, 8, 9])
    // C B A come out first, then 0 to 5: "we expect to see CBA012345".
    expect(readOrder(slots)).toEqual([7, 8, 9, 0, 1, 2, 3, 4, 5])
    expect(at(slots, 'isRead')).toEqual([7])
    expect(at(slots, 'isWrite')).toEqual([6])
  })

  it('tells a full queue from an empty one by the count, not the pointers', () => {
    const full = ringSlots(ring(7, 7, 10))!
    const empty = ringSlots(ring(7, 7, 0))!
    expect(full.every((s) => s.occupied)).toBe(true)
    expect(readOrder(full)).toEqual([7, 8, 9, 0, 1, 2, 3, 4, 5, 6])
    expect(empty.some((s) => s.occupied)).toBe(false)
    expect(at(full, 'isWrite')).toEqual(at(empty, 'isWrite'))
  })

  it('moves R on as the consumer reads', () => {
    let q = ring(0, 0, 0)
    for (let round = 0; round < 3; round++) q = putFront(put(put(q)))
    q = get(get(q))
    const slots = ringSlots(q)!
    expect(readOrder(slots)).toEqual([9, 0, 1, 2, 3, 4, 5])
    expect(at(slots, 'isRead')).toEqual([9])
  })

  it('counts slots in messages, not bytes', () => {
    const slots = ringSlots(ring(6, 1, 3, 8, 16))!
    expect(readOrder(slots)).toEqual([6, 7, 0])
    expect(slots[7]!.addr).toBe(BASE + 7 * 16)
  })
})

describe('isRing', () => {
  it('refuses what is not a ring rather than drawing it', () => {
    expect(isRing(ring(0, 0, 0))).toBe(true)
    // Not initialized yet: k_msgq_init() has not run.
    expect(isRing({ msgSize: 0, maxMsgs: 0, used: 0, bufferStart: 0, bufferEnd: 0, readPtr: 0, writePtr: 0 })).toBe(false)
    expect(isRing(ring(0, 0, 11))).toBe(false) // more messages than slots
    expect(isRing({ ...ring(0, 0, 0), bufferEnd: BASE + 9 })).toBe(false) // buffer is not max_msgs slots
    expect(isRing({ ...ring(0, 0, 0), readPtr: BASE - 1 })).toBe(false) // outside the buffer
    expect(isRing({ ...ring(0, 0, 0, 8, 4), writePtr: BASE + 6 })).toBe(false) // between two slots
    expect(ringSlots({ ...ring(0, 0, 0), readPtr: BASE + 11 })).toBeNull()
  })
})

describe('slotOf', () => {
  it('reads a pointer one past the end as the slot it is about to wrap to', () => {
    // A stop between `write_ptr += msg_size` and the wrap check.
    expect(slotOf(ring(0, 0, 0), BASE + 10)).toBe(0)
    expect(slotOf(ring(0, 0, 0), BASE + 3)).toBe(3)
    expect(slotOf(ring(0, 0, 0, 4, 8), BASE + 12)).toBeNull()
  })
})

describe('slotBytes', () => {
  it('cuts the buffer into messages, and has nothing for a slot it never read', () => {
    const q = { ...ring(0, 0, 0, 4, 2), bytes: Uint8Array.of(1, 2, 3, 4, 5) }
    expect([...slotBytes(q, 1)!]).toEqual([3, 4])
    expect([...slotBytes(q, 2)!]).toEqual([5]) // the read stopped mid-message
    expect(slotBytes(q, 3)).toBeNull()
    expect(slotBytes({ ...q, bytes: null }, 0)).toBeNull()
  })
})
