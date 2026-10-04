/**
 * A `k_msgq` as the ring buffer it is.
 *
 * The queue keeps its messages in one flat buffer and two pointers into it.
 * `read_ptr` is the next message out and `write_ptr` the next free slot in: a
 * put copies to W and moves it on, a get copies from R and moves it on, and
 * both wrap at `buffer_end`. `k_msgq_put_front()` is the one move the other
 * way: R steps back a slot, wrapping to the last one, and the message lands in
 * front of the queue.
 *
 * R == W means "empty" or "full", and only the kernel's `used_msgs` knows which.
 *
 * Pure geometry, no guest access: the decoding lives with the other object
 * readers in objectCores.ts.
 */

/**
 * Most slots a card draws. Four rows of sixteen still reads at a glance; a
 * bigger queue keeps its plain row instead of a wall of cells.
 */
export const MAX_RING_SLOTS = 64

/** A queue's ring, from one read of its struct. Addresses are guest addresses. */
export interface MsgqRing {
  /** Bytes per message. */
  msgSize: number
  /** Slots in the buffer. */
  maxMsgs: number
  /** Messages waiting to be read, as the kernel counts them. */
  used: number
  bufferStart: number
  bufferEnd: number
  readPtr: number
  writePtr: number
}

/** A ring as one stop saw it: the struct's pointers and the buffer behind them. */
export interface MsgqRingSnapshot extends MsgqRing {
  /**
   * The buffer from `bufferStart`, read in the same stop. Possibly cut short of
   * the whole buffer, and null when it would not read.
   */
  bytes: Uint8Array | null
}

export interface RingSlot {
  /** 0-based, in buffer order. */
  index: number
  addr: number
  /** Holds a message nobody has read yet. */
  occupied: boolean
  /** Place in the read order: 1 is the next message out. 0 for a free slot. */
  order: number
  /** `read_ptr` points here. */
  isRead: boolean
  /** `write_ptr` points here. */
  isWrite: boolean
}

/**
 * The slot a pointer lands on, or null when it is not on a slot boundary
 * inside the buffer.
 */
export function slotOf(ring: MsgqRing, ptr: number): number | null {
  const offset = ptr - ring.bufferStart
  if (offset < 0 || offset % ring.msgSize !== 0) return null
  const index = offset / ring.msgSize
  // One past the end is the instant between moving a pointer on and wrapping
  // it, which a stop inside the kernel can land in. It means slot 0.
  if (index === ring.maxMsgs) return 0
  return index < ring.maxMsgs ? index : null
}

/**
 * True when the struct describes a ring: a buffer of `maxMsgs` slots, a count
 * that fits in it, and both pointers on a slot. Not yet initialized, or not a
 * message queue at all, fails here rather than drawing nonsense.
 */
export function isRing(ring: MsgqRing): boolean {
  const { msgSize, maxMsgs, used } = ring
  if (!Number.isSafeInteger(msgSize) || msgSize <= 0) return false
  if (!Number.isSafeInteger(maxMsgs) || maxMsgs <= 0) return false
  if (ring.bufferEnd - ring.bufferStart !== msgSize * maxMsgs) return false
  if (!Number.isSafeInteger(used) || used < 0 || used > maxMsgs) return false
  return slotOf(ring, ring.readPtr) !== null && slotOf(ring, ring.writePtr) !== null
}

/**
 * Every slot, in buffer order, or null when the struct is not a ring.
 *
 * Occupancy is counted from R: the `used` slots starting there, wrapping. That
 * is what settles full against empty when the pointers agree. A stop inside
 * the kernel can land between a pointer move and the count's update; the strip
 * then shows what the struct says, disagreement included, rather than guess.
 */
export function ringSlots(ring: MsgqRing): RingSlot[] | null {
  if (!isRing(ring)) return null
  const read = slotOf(ring, ring.readPtr)!
  const write = slotOf(ring, ring.writePtr)!
  const slots: RingSlot[] = Array.from({ length: ring.maxMsgs }, (_, index) => ({
    index,
    addr: ring.bufferStart + index * ring.msgSize,
    occupied: false,
    order: 0,
    isRead: index === read,
    isWrite: index === write,
  }))
  for (let k = 0; k < ring.used; k++) {
    const slot = slots[(read + k) % ring.maxMsgs]!
    slot.occupied = true
    slot.order = k + 1
  }
  return slots
}

/**
 * The bytes of one slot's message, or null when they were not read (the buffer
 * read failed, or was cut short before this slot).
 */
export function slotBytes(ring: MsgqRingSnapshot, index: number): Uint8Array | null {
  if (!ring.bytes) return null
  const start = index * ring.msgSize
  if (start >= ring.bytes.length) return null
  return ring.bytes.subarray(start, Math.min(start + ring.msgSize, ring.bytes.length))
}
