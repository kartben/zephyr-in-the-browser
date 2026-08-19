import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attach, available, detach } from './hostI2c'
import { i2cModel } from './virtio'
import { createTmp112 } from './virtio/devices/chips/tmp112'
import { createAt24 } from './virtio/devices/chips/at24'
import { HOST_POLL_MS } from './hostPoll'

/**
 * The shared-area layout, spelled out again rather than imported: this is the
 * contract with hw/i2c/host_i2c.c, and a test that reads it from the module
 * under test would agree with any drift. Byte offsets.
 */
const AREA = {
  magic: 0,
  version: 4,
  present: 8,
  attached: 24,
  reqSeq: 28,
  rspSeq: 32,
  op: 36,
  addr: 40,
  len: 44,
  flags: 48,
  status: 52,
  data: 60,
} as const

const AREA_MAGIC = 0x42433249
const OP_WRITE = 1
const OP_READ = 2
const F_FIRST = 1
const STATUS_ACK = 0
const STATUS_NAK = 1

/** Where the area sits in the fake heap. Any 4-aligned offset will do. */
const BASE = 4096

interface Heap {
  bytes: Uint8Array
  words: Int32Array
}

function makeHeap(): Heap {
  const buffer = new ArrayBuffer(16384)
  const bytes = new Uint8Array(buffer)
  const words = new Int32Array(buffer)
  words[(BASE + AREA.magic) >> 2] = AREA_MAGIC
  words[(BASE + AREA.version) >> 2] = 1
  return { bytes, words }
}

describe('hostI2c', () => {
  let heap: Heap

  const word = (offset: number) => heap.words[(BASE + offset) >> 2]!
  const setWord = (offset: number, value: number) => {
    heap.words[(BASE + offset) >> 2] = value
  }

  /** Post one request the way hw/i2c/host_i2c.c does, and let the page run. */
  function request(op: number, address: number, len: number, flags = 0, payload?: Uint8Array) {
    setWord(AREA.op, op)
    setWord(AREA.addr, address)
    setWord(AREA.len, len)
    setWord(AREA.flags, flags)
    if (payload) heap.bytes.set(payload, BASE + AREA.data)
    setWord(AREA.reqSeq, word(AREA.reqSeq) + 1)
    // No Worker in this environment, so the module is on its polling fallback.
    vi.advanceTimersByTime(HOST_POLL_MS)
    return {
      status: word(AREA.status),
      data: heap.bytes.slice(BASE + AREA.data, BASE + AREA.data + len),
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    // The singleton bus comes up with whatever the fallback devicetree wants.
    for (const chip of [...i2cModel.chips()]) i2cModel.detachChip(chip.address)
    heap = makeHeap()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    attach({ _qemu_host_i2c_area: () => BASE, HEAPU8: heap.bytes })
  })

  afterEach(() => {
    detach()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('binds to an area whose magic checks out', () => {
    expect(available()).toBe(true)
    expect(word(AREA.attached)).toBe(1)
  })

  it('refuses an area that is not one', () => {
    detach()
    setWord(AREA.magic, 0xdeadbeef)
    attach({ _qemu_host_i2c_area: () => BASE, HEAPU8: heap.bytes })
    expect(available()).toBe(false)
  })

  it('publishes a presence bit per attached chip, and clears it on detach', () => {
    expect(word(AREA.present + 0)).toBe(0)

    const tmp = createTmp112({ address: 0x48 })
    i2cModel.attachChip(tmp)
    // 0x48 is bit 8 of word 2.
    expect(word(AREA.present + 8)).toBe(1 << 8)

    i2cModel.detachChip(0x48)
    expect(word(AREA.present + 8)).toBe(0)
  })

  it('stops answering once the page lets go', () => {
    i2cModel.attachChip(createTmp112({ address: 0x48 }))
    detach()
    expect(word(AREA.attached)).toBe(0)
    expect(word(AREA.present + 8)).toBe(0)
  })

  it('hands a write message to the chip at that address', () => {
    const eeprom = createAt24({ address: 0x50 })
    i2cModel.attachChip(eeprom)

    // AT24 word address 0x00, then three bytes.
    const answer = request(OP_WRITE, 0x50, 4, 0, Uint8Array.of(0x00, 0xde, 0xad, 0xbe))
    expect(answer.status).toBe(STATUS_ACK)

    request(OP_WRITE, 0x50, 1, 0, Uint8Array.of(0x00))
    expect(Array.from(request(OP_READ, 0x50, 3, F_FIRST).data)).toEqual([0xde, 0xad, 0xbe])
  })

  it('serves a read split into runs the way the controller asks for it', () => {
    const tmp = createTmp112({ address: 0x48 })
    i2cModel.attachChip(tmp)
    tmp.setCelsius(-10) // 0xf6 0x00

    request(OP_WRITE, 0x48, 1, 0, Uint8Array.of(0x00))
    // The driver reads N bytes as N-1 then 1; only the first run opens the
    // message, and the second must not start the register over.
    expect(Array.from(request(OP_READ, 0x48, 1, F_FIRST).data)).toEqual([0xf6])
    expect(Array.from(request(OP_READ, 0x48, 1, 0).data)).toEqual([0x00])
  })

  it('NAKs an address nothing answers at', () => {
    i2cModel.attachChip(createTmp112({ address: 0x48 }))
    expect(request(OP_READ, 0x49, 1, F_FIRST).status).toBe(STATUS_NAK)
    expect(request(OP_WRITE, 0x49, 1, 0, Uint8Array.of(0)).status).toBe(STATUS_NAK)
  })

  it('answers each request exactly once, in sequence', () => {
    i2cModel.attachChip(createTmp112({ address: 0x48 }))

    request(OP_WRITE, 0x48, 1, 0, Uint8Array.of(0x00))
    expect(word(AREA.rspSeq)).toBe(word(AREA.reqSeq))

    const before = word(AREA.rspSeq)
    vi.advanceTimersByTime(HOST_POLL_MS * 3)
    // Nothing new was posted, so nothing was answered.
    expect(word(AREA.rspSeq)).toBe(before)
  })
})
