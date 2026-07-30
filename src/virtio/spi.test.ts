import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('covers the stock spi_flash sample offset 0xff000', () => {
    const flash = createW25q({ cs: 0 })
    spi.attachChip(flash)
    expect(flash.decl.size).toBeGreaterThanOrEqual(0xff000 + 4096)

    expect(xfer(0, Uint8Array.of(0x06), 0).status).toBe(TRANS_OK)
    expect(xfer(0, Uint8Array.of(0x20, 0x0f, 0xf0, 0x00), 0).status).toBe(TRANS_OK)
    expect(xfer(0, Uint8Array.of(0x06), 0).status).toBe(TRANS_OK)
    expect(
      xfer(0, Uint8Array.of(0x02, 0x0f, 0xf0, 0x00, 0x55, 0xaa, 0x66, 0x99), 0).status,
    ).toBe(TRANS_OK)

    const readCmd = Uint8Array.of(0x03, 0x0f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00)
    const { status, data } = xfer(0, readCmd, 8)
    expect(status).toBe(TRANS_OK)
    expect(data.slice(4)).toEqual(Uint8Array.of(0x55, 0xaa, 0x66, 0x99))
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

  /**
   * The dot on a chip's card. A transfer is microseconds wide, so the model
   * stretches the assert to something a reader can see, and holds it for as long
   * as the guest keeps CS low.
   */
  describe('chip select state', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('lights the selected line and lets it fall on its own', () => {
      spi.attachChip(createSpiLoopback(0))
      const seen: boolean[] = []
      spi.subscribe(() => seen.push(spi.csAsserted(0)))

      expect(spi.csAsserted(0)).toBe(false)
      xfer(0, Uint8Array.of(0xaa), 1)
      expect(spi.csAsserted(0)).toBe(true)

      vi.advanceTimersByTime(100)
      expect(spi.csAsserted(0)).toBe(true)
      vi.advanceTimersByTime(120)
      expect(spi.csAsserted(0)).toBe(false)
      // One notify for the rise, one for the fall — plus the throttled log.
      expect(seen).toContain(true)
      expect(seen.at(-1)).toBe(false)
    })

    it('stays lit while transfers keep coming', () => {
      spi.attachChip(createSpiLoopback(0))
      for (let i = 0; i < 6; i++) {
        xfer(0, Uint8Array.of(i), 1)
        vi.advanceTimersByTime(60)
        expect(spi.csAsserted(0)).toBe(true)
      }
      vi.advanceTimersByTime(200)
      expect(spi.csAsserted(0)).toBe(false)
    })

    it('holds the line while cs_change is clear, and releases on the last transfer', () => {
      spi.attachChip(createSpiLoopback(0))
      xfer(0, Uint8Array.of(0x9f), 1, false)
      vi.advanceTimersByTime(5_000)
      expect(spi.csAsserted(0)).toBe(true)

      xfer(0, Uint8Array.of(0x00), 1)
      vi.advanceTimersByTime(200)
      expect(spi.csAsserted(0)).toBe(false)
    })

    it('lights only the line being clocked', () => {
      spi.attachChip(createSpiLoopback(0, 'A'))
      spi.attachChip(createSpiLoopback(1, 'B'))
      xfer(1, Uint8Array.of(0xaa), 1)
      expect(spi.csAsserted(0)).toBe(false)
      expect(spi.csAsserted(1)).toBe(true)
    })

    it('lights an empty chip select — the guest still drove it', () => {
      expect(xfer(3, Uint8Array.of(0xaa), 1).status).toBe(TRANS_ERR)
      expect(spi.csAsserted(3)).toBe(true)
    })

    it('drops a held line when the guest resets the device', () => {
      spi.attachChip(createSpiLoopback(0))
      xfer(0, Uint8Array.of(0xaa), 1, false)
      expect(spi.csAsserted(0)).toBe(true)

      spi.reset!()
      expect(spi.csAsserted(0)).toBe(false)
    })

    it('forgets a held line when the chip is detached or replaced', () => {
      spi.attachChip(createSpiLoopback(0))
      xfer(0, Uint8Array.of(0xaa), 1, false)
      expect(spi.csAsserted(0)).toBe(true)

      spi.detachChip(0)
      expect(spi.csAsserted(0)).toBe(false)

      spi.attachChip(createSpiLoopback(0))
      expect(spi.csAsserted(0)).toBe(false)
    })
  })
})
