import { describe, expect, it, vi } from 'vitest'
import { createMcp2515, isMcp2515, MCP2515_REGS as R } from './mcp2515'
import type { CanFrame } from '@/can/bus'

const OPTS = { csChange: true, bitsPerWord: 8, mode: 0, freq: 1_000_000 }

/** Half-duplex helpers over the full-duplex `transfer` the bus model calls. */
function write(chip: ReturnType<typeof createMcp2515>, bytes: number[]) {
  const tx = Uint8Array.from(bytes)
  chip.transfer(tx, new Uint8Array(tx.length), OPTS)
}

function read(chip: ReturnType<typeof createMcp2515>, cmd: number[], len: number): Uint8Array {
  const tx = new Uint8Array(cmd.length + len)
  tx.set(cmd)
  const rx = new Uint8Array(tx.length)
  chip.transfer(tx, rx, OPTS)
  return rx.slice(cmd.length)
}

const CMD_RESET = 0xc0
const CMD_READ = 0x03
const CMD_WRITE = 0x02
const CMD_BIT_MODIFY = 0x05
const CMD_RTS = 0x80
const CMD_READ_RX0 = 0x90

const frame = (id: number, data: number[] = [1, 2, 3]): CanFrame => ({
  id,
  ext: false,
  rtr: false,
  data: Uint8Array.from(data),
})

describe('reset and mode', () => {
  it('comes up in configuration mode', () => {
    const chip = createMcp2515()
    write(chip, [CMD_RESET])
    expect(chip.mode()).toBe(R.MODE_CONFIG)
    expect(read(chip, [CMD_READ, R.CANCTRL], 1)[0]).toBe(0x87)
  })

  it('reflects a requested mode straight into CANSTAT.OPMOD', () => {
    // The driver spins on this readback; not applying it hangs probe.
    const chip = createMcp2515()
    write(chip, [CMD_RESET])
    write(chip, [CMD_WRITE, R.CANCTRL, R.MODE_NORMAL << 5])
    expect(chip.mode()).toBe(R.MODE_NORMAL)
    expect(read(chip, [CMD_READ, R.CANSTAT], 1)[0]! >> 5).toBe(R.MODE_NORMAL)
  })

  it('bit modify touches only the masked bits', () => {
    const chip = createMcp2515()
    write(chip, [CMD_RESET])
    write(chip, [CMD_WRITE, R.CANINTE, 0b0000_0011])
    write(chip, [CMD_BIT_MODIFY, R.CANINTE, 0b0000_0100, 0b1111_1111])
    expect(read(chip, [CMD_READ, R.CANINTE], 1)[0]).toBe(0b0000_0111)
    write(chip, [CMD_BIT_MODIFY, R.CANINTE, 0b0000_0001, 0b0000_0000])
    expect(read(chip, [CMD_READ, R.CANINTE], 1)[0]).toBe(0b0000_0110)
  })
})

describe('transmit', () => {
  function normalChip(onTransmit: (f: CanFrame) => void) {
    const chip = createMcp2515({ onTransmit })
    write(chip, [CMD_RESET])
    write(chip, [CMD_WRITE, R.CANCTRL, R.MODE_NORMAL << 5])
    return chip
  }

  it('turns a loaded buffer plus RTS into a frame', () => {
    const sent: CanFrame[] = []
    const chip = normalChip((f) => sent.push(f))

    // id 0x100 -> SIDH 0x20, SIDL 0x00
    write(chip, [CMD_WRITE, R.TXB0 + 1, 0x20, 0x00, 0x00, 0x00, 0x02, 0xaa, 0xbb])
    write(chip, [CMD_RTS | 0x01])

    expect(sent).toHaveLength(1)
    expect(sent[0]!.id).toBe(0x100)
    expect(sent[0]!.ext).toBe(false)
    expect([...sent[0]!.data]).toEqual([0xaa, 0xbb])
  })

  it('setting TXREQ by a plain register write also sends', () => {
    const sent: CanFrame[] = []
    const chip = normalChip((f) => sent.push(f))
    write(chip, [CMD_WRITE, R.TXB0 + 1, 0x20, 0x00, 0x00, 0x00, 0x01, 0x77])
    write(chip, [CMD_WRITE, R.TXB0, 0x08])
    expect(sent).toHaveLength(1)
    expect([...sent[0]!.data]).toEqual([0x77])
  })

  it('clears TXREQ and latches TX0IF once the frame is away', () => {
    const chip = normalChip(() => {})
    write(chip, [CMD_WRITE, R.TXB0 + 5, 0x00])
    write(chip, [CMD_RTS | 0x01])
    expect(read(chip, [CMD_READ, R.TXB0], 1)[0]! & 0x08).toBe(0)
    expect(read(chip, [CMD_READ, R.CANINTF], 1)[0]! & 0x04).toBe(0x04)
  })

  it('listen-only puts nothing on the wire', () => {
    const sent: CanFrame[] = []
    const chip = createMcp2515({ onTransmit: (f) => sent.push(f) })
    write(chip, [CMD_RESET])
    write(chip, [CMD_WRITE, R.CANCTRL, R.MODE_LISTEN_ONLY << 5])
    write(chip, [CMD_WRITE, R.TXB0 + 5, 0x01])
    write(chip, [CMD_RTS | 0x01])
    expect(sent).toHaveLength(0)
  })

  it('loopback delivers to itself instead of the bus', () => {
    const sent: CanFrame[] = []
    const chip = createMcp2515({ onTransmit: (f) => sent.push(f) })
    write(chip, [CMD_RESET])
    write(chip, [CMD_WRITE, R.CANCTRL, R.MODE_LOOPBACK << 5])
    write(chip, [CMD_WRITE, R.TXB0 + 1, 0x20, 0x00, 0x00, 0x00, 0x01, 0x42])
    write(chip, [CMD_RTS | 0x01])

    expect(sent).toHaveLength(0)
    expect(read(chip, [CMD_READ, R.CANINTF], 1)[0]! & 0x01).toBe(0x01)
  })
})

describe('receive', () => {
  function normalChip(onInt?: (a: boolean) => void) {
    const chip = createMcp2515({ onInt })
    write(chip, [CMD_RESET])
    write(chip, [CMD_WRITE, R.CANCTRL, R.MODE_NORMAL << 5])
    return chip
  }

  it('lands a frame in buffer 0 and raises INT when enabled', () => {
    const int = vi.fn()
    const chip = normalChip(int)
    write(chip, [CMD_WRITE, R.CANINTE, 0x01])

    expect(chip.deliver(frame(0x123, [9, 8, 7]))).toBe('accepted')

    expect(read(chip, [CMD_READ, R.RXB0 + 1], 1)[0]).toBe(0x24)
    expect(read(chip, [CMD_READ, R.RXB0 + 5], 1)[0]! & 0x0f).toBe(3)
    expect([...read(chip, [CMD_READ, R.RXB0 + 6], 3)]).toEqual([9, 8, 7])
    expect(int).toHaveBeenLastCalledWith(true)
    expect(chip.intAsserted()).toBe(true)
  })

  it('READ RX drains the buffer and drops INT', () => {
    const int = vi.fn()
    const chip = normalChip(int)
    write(chip, [CMD_WRITE, R.CANINTE, 0x01])
    chip.deliver(frame(0x123))

    const out = read(chip, [CMD_READ_RX0], 5)
    expect(out[0]).toBe(0x24) // SIDH
    expect(read(chip, [CMD_READ, R.CANINTF], 1)[0]! & 0x01).toBe(0)
    expect(chip.intAsserted()).toBe(false)
    expect(int).toHaveBeenLastCalledWith(false)
  })

  it('rolls into the second buffer, then overflows rather than filtering', () => {
    // The distinction matters: Zephyr's driver sets RXM to masks-off and
    // filters in software, so overflow is the only drop a real guest produces.
    const chip = normalChip()
    expect(chip.deliver(frame(0x100))).toBe('accepted')
    expect(chip.deliver(frame(0x101))).toBe('accepted')
    expect(chip.deliver(frame(0x102))).toBe('overflow')
    // Latched in EFLG, where the Registers dialog shows it.
    expect(read(chip, [CMD_READ, 0x2d], 1)[0]! & 0xc0).toBe(0xc0)
  })

  it('masks-off is what the driver actually programs, and takes everything', () => {
    const chip = normalChip()
    // rx0_ctrl = BIT(6)|BIT(5)|BIT(2) in can_mcp2515.c: RXM=11 plus BUKT.
    write(chip, [CMD_WRITE, 0x60, 0x64])
    write(chip, [CMD_WRITE, 0x70, 0x60])
    expect(chip.deliver(frame(0x7ff))).toBe('accepted')
    read(chip, [CMD_READ_RX0], 13)
    expect(chip.deliver({ id: 0x12345, ext: true, rtr: false, data: Uint8Array.from([1, 2]) })).toBe(
      'accepted',
    )
  })

  it('round-trips an extended id, which the counter sample uses', () => {
    // samples/drivers/can/counter sends COUNTER_MSG_ID 0x12345 with
    // CAN_FRAME_IDE, so the 29-bit path is load-bearing, not decorative.
    const chip = normalChip()
    expect(
      chip.deliver({ id: 0x12345, ext: true, rtr: false, data: Uint8Array.from([0xaa, 0xbb]) }),
    ).toBe('accepted')

    const sidh = read(chip, [CMD_READ, R.RXB0 + 1], 4)
    const std = ((sidh[0]! << 3) | (sidh[1]! >> 5)) & 0x7ff
    const low = ((sidh[1]! & 0x03) << 16) | (sidh[2]! << 8) | sidh[3]!
    expect(sidh[1]! & 0x08).toBe(0x08) // EXIDE set
    expect(((std << 18) | low) >>> 0).toBe(0x12345)
    expect([...read(chip, [CMD_READ, R.RXB0 + 6], 2)]).toEqual([0xaa, 0xbb])
  })

  it('takes nothing while still in configuration mode', () => {
    const chip = createMcp2515()
    write(chip, [CMD_RESET])
    expect(chip.deliver(frame(0x100))).toBe('filtered')
  })

  describe('acceptance filters', () => {
    it('a zero mask accepts everything, as on silicon', () => {
      const chip = normalChip()
      expect(chip.deliver(frame(0x7ff))).toBe('accepted')
    })

    it('a programmed mask and filter drop a non-matching id', () => {
      const chip = normalChip()
      // mask 0x7F0, filter 0x100 -> 0x10x accepted, everything else dropped.
      // Both masks have to be programmed: an untouched mask is zero, which is
      // "every bit don't care", so the second buffer would take the frame.
      write(chip, [CMD_WRITE, 0x20, 0xfe, 0x00]) // RXM0 = 0x7F0
      write(chip, [CMD_WRITE, 0x24, 0xfe, 0x00]) // RXM1 = 0x7F0
      write(chip, [CMD_WRITE, 0x00, 0x20, 0x00]) // RXF0 = 0x100

      expect(chip.deliver(frame(0x105))).toBe('accepted')
      // Drain so buffer pressure is not what rejects the next one.
      read(chip, [CMD_READ_RX0], 13)
      expect(chip.deliver(frame(0x2ff))).toBe('filtered')
    })
  })
})

describe('identity', () => {
  it('is recognisable as a CAN chip and exposes its map', () => {
    const chip = createMcp2515({ cs: 0 })
    expect(isMcp2515(chip)).toBe(true)
    expect(chip.registers.some((r) => r.name === 'CANCTRL')).toBe(true)
    expect(chip.registers.some((r) => r.name === 'CANINTF')).toBe(true)
  })
})
