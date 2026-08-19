import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attach, available, detach } from './hostSpi'
import { spiModel } from './virtio'
import { createW25q } from './virtio/devices/chips/w25q'
import { HOST_POLL_MS } from './hostPoll'

/**
 * The shared-area layout, spelled out again rather than imported: this is the
 * contract with hw/ssi/host_spi.c. Byte offsets.
 */
const AREA = {
  magic: 0,
  version: 4,
  present: 8,
  attached: 12,
  reqSeq: 16,
  rspSeq: 20,
  op: 24,
  cs: 28,
  len: 32,
  flags: 36,
  status: 40,
  data: 48,
} as const

const AREA_MAGIC = 0x42535053
const OP_TRANSFER = 1
const F_CS_RELEASE = 1
const STATUS_OK = 0
const STATUS_ERR = 1

const BASE = 4096

/** JEDEC RDID, which is what a NOR answers first and a bare bus does not. */
const CMD_RDID = 0x9f

interface Heap {
  bytes: Uint8Array
  words: Int32Array
}

function makeHeap(): Heap {
  const buffer = new ArrayBuffer(32768)
  const bytes = new Uint8Array(buffer)
  const words = new Int32Array(buffer)
  words[(BASE + AREA.magic) >> 2] = AREA_MAGIC
  words[(BASE + AREA.version) >> 2] = 1
  return { bytes, words }
}

describe('hostSpi', () => {
  let heap: Heap

  const word = (offset: number) => heap.words[(BASE + offset) >> 2]!
  const setWord = (offset: number, value: number) => {
    heap.words[(BASE + offset) >> 2] = value
  }

  /** Clock one run the way hw/ssi/host_spi.c does, and let the page run. */
  function run(cs: number, tx: number[], csRelease = true) {
    setWord(AREA.op, OP_TRANSFER)
    setWord(AREA.cs, cs)
    setWord(AREA.len, tx.length)
    setWord(AREA.flags, csRelease ? F_CS_RELEASE : 0)
    heap.bytes.set(Uint8Array.from(tx), BASE + AREA.data)
    setWord(AREA.reqSeq, word(AREA.reqSeq) + 1)
    // No Worker here, so the module is on its polling fallback.
    vi.advanceTimersByTime(HOST_POLL_MS)
    return {
      status: word(AREA.status),
      data: Array.from(heap.bytes.slice(BASE + AREA.data, BASE + AREA.data + tx.length)),
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    for (const chip of [...spiModel.chips()]) spiModel.detachChip(chip.cs)
    heap = makeHeap()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    attach({ _qemu_host_spi_area: () => BASE, HEAPU8: heap.bytes })
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
    attach({ _qemu_host_spi_area: () => BASE, HEAPU8: heap.bytes })
    expect(available()).toBe(false)
  })

  it('publishes a presence bit per chip select, and clears it on detach', () => {
    expect(word(AREA.present)).toBe(0)
    spiModel.attachChip(createW25q({ cs: 0 }))
    expect(word(AREA.present)).toBe(1)

    detach()
    expect(word(AREA.present)).toBe(0)
    expect(word(AREA.attached)).toBe(0)
  })

  it('clocks a run through the chip on that select', () => {
    spiModel.attachChip(createW25q({ cs: 0 }))

    // The JEDEC id comes back in the bytes that follow the command, which is
    // what the whole full-duplex arrangement has to get right.
    const answer = run(0, [CMD_RDID, 0, 0, 0])
    expect(answer.status).toBe(STATUS_OK)
    // 0xff while the part is still taking the command byte in, then the id.
    expect(answer.data).toEqual([0xff, 0xef, 0x40, 0x14])
  })

  it('carries a command across runs while the select is held', () => {
    const nor = createW25q({ cs: 0 })
    spiModel.attachChip(nor)

    // Command in one run, data in the next, select held across them, which is
    // exactly how the ESP32 controller splits it.
    expect(run(0, [CMD_RDID], false).status).toBe(STATUS_OK)
    expect(run(0, [0, 0, 0], true).data).toEqual([0xef, 0x40, 0x14])
  })

  it('fails a run on a chip select with nothing on it', () => {
    spiModel.attachChip(createW25q({ cs: 0 }))
    expect(run(1, [CMD_RDID, 0, 0, 0]).status).toBe(STATUS_ERR)
  })

  it('answers each run exactly once', () => {
    spiModel.attachChip(createW25q({ cs: 0 }))
    run(0, [CMD_RDID, 0, 0, 0])
    expect(word(AREA.rspSeq)).toBe(word(AREA.reqSeq))

    const before = word(AREA.rspSeq)
    vi.advanceTimersByTime(HOST_POLL_MS * 3)
    expect(word(AREA.rspSeq)).toBe(before)
  })
})
