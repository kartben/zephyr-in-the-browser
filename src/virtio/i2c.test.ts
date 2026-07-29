import { beforeEach, describe, expect, it } from 'vitest'

import { createFakeBridge, type FakeDevice } from './testing/fakeBridge'
import { createI2cModel, type I2cModel } from './devices/i2c'
import { createAt24 } from './devices/chips/at24'
import { createTmp112 } from './devices/chips/tmp112'
import { createSsd1306 } from './devices/chips/ssd1306'
import { attach, detach, pollOnce, register } from './transport'

const VIRTIO_ID_I2C_ADAPTER = 34

const FLAGS_FAIL_NEXT = 1 << 0
const FLAGS_M_RD = 1 << 1

const MSG_OK = 0
const MSG_ERR = 1

/**
 * One `struct i2c_msg` as the guest driver puts it on the wire: an out_hdr
 * with the address shifted left by one, then the write payload if any.
 */
function outHdr(address: number, flags: number, payload?: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + (payload?.length ?? 0))
  const dv = new DataView(buf.buffer)
  dv.setUint16(0, address << 1, true)
  dv.setUint16(2, 0, true)
  dv.setUint32(4, flags, true)
  if (payload) buf.set(payload, 8)
  return buf
}

describe('virtio-i2c model', () => {
  let bridge: ReturnType<typeof createFakeBridge>
  let dev: FakeDevice
  let i2c: I2cModel

  /** A write message. Returns the status byte. */
  function write(address: number, payload: Uint8Array, flags = 0): number {
    dev.kick(0, outHdr(address, flags, payload), 1)
    pollOnce()
    const [done] = dev.completions()
    return done.data[done.data.length - 1]
  }

  /** A read message. Returns the status byte and the bytes read. */
  function read(address: number, length: number, flags = 0) {
    dev.kick(0, outHdr(address, flags | FLAGS_M_RD), length + 1)
    pollOnce()
    const [done] = dev.completions()
    return { status: done.data[done.data.length - 1], data: done.data.slice(0, length) }
  }

  beforeEach(() => {
    detach()
    bridge = createFakeBridge([
      { name: 'i2c', deviceId: VIRTIO_ID_I2C_ADAPTER, numQueues: 1 },
    ])
    dev = bridge.device('i2c')
    i2c = createI2cModel()
    register(i2c)
    attach(bridge.module)
    pollOnce()
  })

  it('NAKs every address when the bus is empty', () => {
    for (const address of [0x04, 0x50, 0x68, 0x77]) {
      expect(read(address, 1).status).toBe(MSG_ERR)
    }
  })

  it('ACKs only the addresses a chip is attached to', () => {
    i2c.attachChip(createAt24({ address: 0x50 }))

    // What `i2c scan` does: a one-byte read of every address in 0x04..0x77.
    const found: number[] = []
    for (let address = 0x04; address <= 0x77; address++) {
      if (read(address, 1).status === MSG_OK) found.push(address)
    }
    expect(found).toEqual([0x50])
  })

  it('stops answering for a chip that has been detached', () => {
    const remove = i2c.attachChip(createAt24({ address: 0x50 }))
    expect(read(0x50, 1).status).toBe(MSG_OK)
    remove()
    expect(read(0x50, 1).status).toBe(MSG_ERR)
  })

  it('refuses two chips at the same address', () => {
    i2c.attachChip(createAt24({ address: 0x50 }))
    expect(() => i2c.attachChip(createAt24({ address: 0x50 }))).toThrow(/already taken/)
  })

  it('reads back what was written, through the EEPROM pointer', () => {
    i2c.attachChip(createAt24({ address: 0x50 }))

    // Write 0xde 0xad 0xbe 0xef at word address 0x10.
    expect(write(0x50, Uint8Array.of(0x10, 0xde, 0xad, 0xbe, 0xef))).toBe(MSG_OK)
    // Random read: set the pointer, then stream from it — what `i2c read` does.
    expect(write(0x50, Uint8Array.of(0x10), FLAGS_FAIL_NEXT)).toBe(MSG_OK)
    expect(read(0x50, 4)).toEqual({
      status: MSG_OK,
      data: Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
    })
  })

  it('auto-increments the read pointer across messages', () => {
    i2c.attachChip(createAt24({ address: 0x50 }))
    write(0x50, Uint8Array.of(0x00, 1, 2, 3, 4))
    write(0x50, Uint8Array.of(0x00), FLAGS_FAIL_NEXT)

    expect(read(0x50, 2).data).toEqual(Uint8Array.of(1, 2))
    expect(read(0x50, 2).data).toEqual(Uint8Array.of(3, 4))
  })

  it('reads 0xff from an erased cell, like the real part', () => {
    i2c.attachChip(createAt24({ address: 0x50 }))
    write(0x50, Uint8Array.of(0x80), FLAGS_FAIL_NEXT)
    expect(read(0x50, 3).data).toEqual(Uint8Array.of(0xff, 0xff, 0xff))
  })

  it('fails the rest of a transfer after a failed message with FAIL_NEXT', () => {
    i2c.attachChip(createAt24({ address: 0x50 }))

    // A transfer aimed at nothing: first message fails and carries FAIL_NEXT,
    // so the second must fail too even though 0x50 would have answered it.
    expect(write(0x51, Uint8Array.of(0x00), FLAGS_FAIL_NEXT)).toBe(MSG_ERR)
    expect(read(0x50, 1, FLAGS_FAIL_NEXT).status).toBe(MSG_ERR)

    // The last message of a transfer clears FAIL_NEXT, so the bus recovers.
    expect(read(0x50, 1).status).toBe(MSG_ERR)
    expect(read(0x50, 1).status).toBe(MSG_OK)
  })

  it('logs real transactions but not scan NAKs', () => {
    i2c.attachChip(createAt24({ address: 0x50 }))

    for (let address = 0x04; address <= 0x77; address++) read(address, 1)
    // 116 probes, exactly one of which found a chip.
    expect(i2c.transactions()).toHaveLength(1)

    write(0x50, Uint8Array.of(0x00, 0xaa))
    const log = i2c.transactions()
    expect(log[log.length - 1]).toMatchObject({
      address: 0x50,
      dir: 'write',
      ok: true,
      chip: 'AT24C02 EEPROM',
      byteLength: 2,
    })
    expect(log[log.length - 1].bytes).toEqual(Uint8Array.of(0x00, 0xaa))
    expect(typeof log[log.length - 1].atMs).toBe('number')
    expect(log[log.length - 1].atMs).toBeGreaterThan(0)
  })

  it('keeps a fixed ring of transactions without shifting the array', () => {
    i2c.attachChip(createAt24({ address: 0x50 }))
    for (let i = 0; i < 600; i++) {
      write(0x50, Uint8Array.of(i & 0xff))
    }
    const log = i2c.transactions()
    expect(log).toHaveLength(500)
    expect(log[0]!.id).toBe(101)
    expect(log[log.length - 1]!.id).toBe(600)
    expect(log[log.length - 1]!.bytes).toEqual(Uint8Array.of(599 & 0xff))
  })

  it('truncates long payloads in the log but remembers the wire length', () => {
    i2c.attachChip(createSsd1306({ address: 0x3c }))
    const payload = new Uint8Array(40)
    for (let i = 0; i < payload.length; i++) payload[i] = i
    write(0x3c, Uint8Array.of(0x40, ...payload))
    const entry = i2c.transactions()[0]!
    expect(entry.byteLength).toBe(41)
    expect(entry.bytes.length).toBe(8)
    expect(entry.bytes[0]).toBe(0x40)
  })

  /**
   * Decode a TMP112 temperature register exactly as drivers/sensor/ti/tmp112
   * does: interpret the big-endian pair as int16, arithmetic-shift right by 3
   * or 4 depending on the extended-mode flag in bit 0, and scale by 0.0625.
   */
  function decodeTmp112(be: Uint8Array): number {
    const raw = (be[0] << 8) | be[1]
    const signed = (raw << 16) >> 16 // sign-extend to 32 bits
    const shift = raw & 1 ? 3 : 4
    return (signed >> shift) * 0.0625
  }

  /** What i2c_burst_read does: point at a register, then read it. */
  function readRegister(address: number, reg: number, length = 2): Uint8Array {
    write(address, Uint8Array.of(reg), FLAGS_FAIL_NEXT)
    return read(address, length).data
  }

  describe('TMP112', () => {
    it('round-trips temperatures the way the Zephyr driver decodes them', () => {
      const tmp = createTmp112({ address: 0x48 })
      i2c.attachChip(tmp)

      for (const celsius of [0, 21, 25.5, 0.0625, 127.9375, -0.0625, -10, -55]) {
        tmp.setCelsius(celsius)
        expect(decodeTmp112(readRegister(0x48, 0x00))).toBeCloseTo(celsius, 4)
      }
    })

    it('sign-extends negative temperatures rather than wrapping', () => {
      const tmp = createTmp112({ address: 0x48 })
      i2c.attachChip(tmp)
      tmp.setCelsius(-10)

      const raw = readRegister(0x48, 0x00)
      // -10 °C is -160 counts; left-justified by 4 that is 0xF600.
      expect([raw[0], raw[1]]).toEqual([0xf6, 0x00])
      expect(decodeTmp112(raw)).toBeCloseTo(-10, 4)
    })

    it('clamps to the range the part can represent', () => {
      const tmp = createTmp112({ address: 0x48 })
      i2c.attachChip(tmp)

      // 127.9375, not 128: the ceiling is 2047 counts, and 2048 would overflow
      // the 12-bit signed field and read back as -128.
      tmp.setCelsius(500)
      expect(decodeTmp112(readRegister(0x48, 0x00))).toBeCloseTo(127.9375, 4)
      tmp.setCelsius(-273)
      expect(decodeTmp112(readRegister(0x48, 0x00))).toBeCloseTo(-55, 4)
    })

    it('switches to 13-bit encoding when the driver sets extended mode', () => {
      const tmp = createTmp112({ address: 0x48 })
      i2c.attachChip(tmp)

      // Config register write: [reg, hi, lo]. EM is BIT(4) of the 16-bit
      // value, which puts it in the *low* byte.
      write(0x48, Uint8Array.of(0x01, 0x60, 0xa0 | 0x10))
      tmp.setCelsius(140) // only reachable in extended mode

      const raw = readRegister(0x48, 0x00)
      expect(raw[1] & 1).toBe(1) // extended flag set
      expect(decodeTmp112(raw)).toBeCloseTo(140, 4)
    })

    it('reads back the config register the driver wrote', () => {
      const tmp = createTmp112({ address: 0x48 })
      i2c.attachChip(tmp)

      write(0x48, Uint8Array.of(0x01, 0x61, 0xa0))
      expect(Array.from(readRegister(0x48, 0x01))).toEqual([0x61, 0xa0])
    })

    it('shares the bus with the EEPROM', () => {
      i2c.attachChip(createAt24({ address: 0x50 }))
      i2c.attachChip(createTmp112({ address: 0x48 }))

      const found: number[] = []
      for (let address = 0x04; address <= 0x77; address++) {
        if (read(address, 1).status === MSG_OK) found.push(address)
      }
      expect(found).toEqual([0x48, 0x50])
    })
  })

  describe('SSD1306', () => {
    const CONTROL_CMD = 0x00
    const CONTROL_DATA = 0x40

    /** One I2C write with its control byte, as the driver sends it. */
    function send(address: number, control: number, payload: number[] | Uint8Array) {
      return write(address, Uint8Array.of(control, ...payload))
    }

    /**
     * The command block Zephyr's ssd1306_write_default emits before the pixels:
     * horizontal addressing, then the column and page windows.
     */
    function addressWindow(x: number, y: number, w: number, h: number) {
      return [0x20, 0x00, 0x21, x, x + w - 1, 0x22, y >> 3, ((y + h) >> 3) - 1]
    }

    it('renders a full frame into GDDRAM, chunked the way the driver chunks it', () => {
      const oled = createSsd1306({ address: 0x3c })
      i2c.attachChip(oled)

      const frame = new Uint8Array(1024)
      for (let i = 0; i < frame.length; i++) frame[i] = (i * 7) & 0xff

      send(0x3c, CONTROL_CMD, addressWindow(0, 0, 128, 64))
      // The driver splits data at SSD1306_I2C_CHUNK_SIZE = 132 bytes, each
      // chunk its own I2C write — so the cursor has to survive between them.
      for (let off = 0; off < frame.length; off += 132) {
        send(0x3c, CONTROL_DATA, frame.subarray(off, Math.min(off + 132, frame.length)))
      }

      expect(oled.memory).toEqual(frame)
      expect(oled.version()).toBeGreaterThan(0)
    })

    it('honours a partial window rather than writing the whole panel', () => {
      const oled = createSsd1306({ address: 0x3c })
      i2c.attachChip(oled)

      // One 8-pixel-tall band, 4 columns wide, at x=10 y=16 (page 2).
      send(0x3c, CONTROL_CMD, addressWindow(10, 16, 4, 8))
      send(0x3c, CONTROL_DATA, [0xaa, 0xbb, 0xcc, 0xdd])

      expect(Array.from(oled.memory.subarray(2 * 128 + 10, 2 * 128 + 14))).toEqual([
        0xaa, 0xbb, 0xcc, 0xdd,
      ])
      // Nothing outside the window moved.
      expect(oled.memory[2 * 128 + 9]).toBe(0)
      expect(oled.memory[2 * 128 + 14]).toBe(0)
      expect(oled.memory[1 * 128 + 10]).toBe(0)
    })

    it('wraps column then page inside the window, in horizontal mode', () => {
      const oled = createSsd1306({ address: 0x3c })
      i2c.attachChip(oled)

      // A 2-column, 2-page window: four bytes should fill it in that order.
      send(0x3c, CONTROL_CMD, [0x20, 0x00, 0x21, 5, 6, 0x22, 0, 1])
      send(0x3c, CONTROL_DATA, [1, 2, 3, 4])

      expect(oled.memory[0 * 128 + 5]).toBe(1)
      expect(oled.memory[0 * 128 + 6]).toBe(2)
      expect(oled.memory[1 * 128 + 5]).toBe(3)
      expect(oled.memory[1 * 128 + 6]).toBe(4)
    })

    it('tracks display on/off and inversion', () => {
      const oled = createSsd1306({ address: 0x3c })
      i2c.attachChip(oled)

      expect(oled.isOn()).toBe(false)
      send(0x3c, CONTROL_CMD, [0xaf])
      expect(oled.isOn()).toBe(true)
      send(0x3c, CONTROL_CMD, [0xa7])
      expect(oled.isInverted()).toBe(true)
      send(0x3c, CONTROL_CMD, [0xa6, 0xae])
      expect(oled.isInverted()).toBe(false)
      expect(oled.isOn()).toBe(false)
    })

    it('steps over command arguments instead of running them as commands', () => {
      const oled = createSsd1306({ address: 0x3c })
      i2c.attachChip(oled)

      // 0xd5's argument is 0xaf, which is also "display on" — a state machine
      // that did not consume arguments would switch the panel on here.
      send(0x3c, CONTROL_CMD, [0xd5, 0xaf])
      expect(oled.isOn()).toBe(false)
    })

    it('NAKs reads, which the driver never issues', () => {
      i2c.attachChip(createSsd1306({ address: 0x3c }))
      expect(read(0x3c, 1).status).toBe(MSG_ERR)
    })
  })

  it('reports the chips on the bus in address order', () => {
    i2c.attachChip(createAt24({ address: 0x54 }))
    i2c.attachChip(createAt24({ address: 0x50 }))
    expect(i2c.chips().map((c) => c.address)).toEqual([0x50, 0x54])
  })
})
