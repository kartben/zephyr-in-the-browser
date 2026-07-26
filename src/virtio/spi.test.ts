import { beforeEach, describe, expect, it } from 'vitest'

import { createFakeBridge, type FakeDevice } from './testing/fakeBridge'
import { createSpiModel, type SpiModel } from './devices/spi'
import { createSpiLoopback, createW25q, W25Q_JEDEC_ID } from './devices/chips/w25q'
import { attach, detach, pollOnce, register } from './transport'

const VIRTIO_ID_SPI = 45
const HEAD_BYTES = 32
const TRANS_OK = 0
const TRANS_ERR = 2

/** Seed matching boards.ts `config=` for the SPI bridge. */
function spiConfig(): Uint8Array {
  const cfg = new Uint8Array(32)
  cfg[0] = 4 // cs_max_number
  cfg[1] = 1 // cs_change_supported
  // bits_per_word_mask = 1 << 7
  cfg[4] = 0x80
  // mode_func_supported = 0x0f
  cfg[8] = 0x0f
  // max_freq_hz = 50_000_000
  new DataView(cfg.buffer).setUint32(12, 50_000_000, true)
  return cfg
}

function head(cs: number, opts: { csChange?: boolean; bits?: number } = {}): Uint8Array {
  const buf = new Uint8Array(HEAD_BYTES)
  const dv = new DataView(buf.buffer)
  buf[0] = cs
  buf[1] = opts.bits ?? 8
  buf[2] = opts.csChange === false ? 0 : 1
  buf[3] = 1 // tx_nbits
  buf[4] = 1 // rx_nbits
  dv.setUint32(8, 0, true) // mode
  dv.setUint32(12, 1_000_000, true) // freq
  return buf
}

describe('virtio-spi model', () => {
  let bridge: ReturnType<typeof createFakeBridge>
  let dev: FakeDevice
  let spi: SpiModel

  function xfer(cs: number, tx: Uint8Array, rxLen: number, csChange = true) {
    const out = new Uint8Array(HEAD_BYTES + tx.length)
    out.set(head(cs, { csChange }))
    out.set(tx, HEAD_BYTES)
    dev.kick(0, out, rxLen + 1)
    pollOnce()
    const [done] = dev.completions()
    return {
      status: done.data[done.data.length - 1]!,
      data: done.data.slice(0, rxLen),
    }
  }

  beforeEach(() => {
    detach()
    bridge = createFakeBridge([
      { name: 'spi', deviceId: VIRTIO_ID_SPI, numQueues: 1, config: spiConfig() },
    ])
    dev = bridge.device('spi')
    spi = createSpiModel()
    register(spi)
    attach(bridge.module)
    pollOnce()
  })

  it('fails transfers when nothing is on the selected CS', () => {
    // Full-duplex lengths must match; unequal is PARAM_ERR even with a chip.
    expect(xfer(0, Uint8Array.of(0x9f, 0x00, 0x00), 3).status).toBe(TRANS_ERR)
  })

  it('loopback echoes TX on RX', () => {
    spi.attachChip(createSpiLoopback(0))
    const { status, data } = xfer(0, Uint8Array.of(0x11, 0x22, 0x33), 3)
    expect(status).toBe(TRANS_OK)
    expect(data).toEqual(Uint8Array.of(0x11, 0x22, 0x33))
  })

  it('refuses two chips on the same CS', () => {
    spi.attachChip(createSpiLoopback(0))
    expect(() => spi.attachChip(createSpiLoopback(0))).toThrow(/already taken/)
  })

  it('reports chips in CS order', () => {
    spi.attachChip(createSpiLoopback(2, 'B'))
    spi.attachChip(createSpiLoopback(0, 'A'))
    expect(spi.chips().map((c) => c.name)).toEqual(['A', 'B'])
  })

  it('reads the JEDEC ID from the W25Q stub', () => {
    spi.attachChip(createW25q({ cs: 0 }))
    // Keep CS asserted across command + data clocks so the FSM stays in RDID.
    const out = new Uint8Array(HEAD_BYTES + 4)
    out.set(head(0, { csChange: true }))
    out.set(Uint8Array.of(0x9f, 0x00, 0x00, 0x00), HEAD_BYTES)
    dev.kick(0, out, 4 + 1)
    pollOnce()
    const [done] = dev.completions()
    expect(done.data[4]).toBe(TRANS_OK)
    expect(done.data.slice(1, 4)).toEqual(W25Q_JEDEC_ID)
  })

  it('programs and reads back through the W25Q stub', () => {
    const flash = createW25q({ cs: 0 })
    spi.attachChip(flash)

    // WREN
    expect(xfer(0, Uint8Array.of(0x06), 0).status).toBe(TRANS_OK)

    // Page program at 0x0010: cmd + addr + 4 data bytes (half-duplex write)
    const pp = Uint8Array.of(0x02, 0x00, 0x00, 0x10, 0xde, 0xad, 0xbe, 0xef)
    expect(xfer(0, pp, 0).status).toBe(TRANS_OK)

    // READ at 0x0010
    const readCmd = Uint8Array.of(0x03, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00)
    const { status, data } = xfer(0, readCmd, 8)
    expect(status).toBe(TRANS_OK)
    expect(data.slice(4)).toEqual(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))
    expect(flash.memory.subarray(0x10, 0x14)).toEqual(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))
  })

  it('logs traffic and clears it', () => {
    spi.attachChip(createSpiLoopback(0))
    xfer(0, Uint8Array.of(0xaa), 1)
    expect(spi.transactions()).toHaveLength(1)
    expect(spi.transactions()[0]!.cs).toBe(0)
    expect(spi.transactions()[0]!.ok).toBe(true)
    spi.clearTransactions()
    expect(spi.transactions()).toHaveLength(0)
  })

  it('exposes cs_max_number from config space', () => {
    expect(spi.csMaxNumber()).toBe(4)
  })
})
