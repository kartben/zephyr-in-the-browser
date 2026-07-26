import { describe, expect, it } from 'vitest'
import { createTmc50xx, isTmc50xx, tmc50xxMeta } from './tmc50xx'
import type { SpiTransferOpts } from '../spi'

const opts: SpiTransferOpts = {
  csChange: true,
  bitsPerWord: 8,
  mode: 3,
  freq: 1_000_000,
}

function xfer(
  chip: ReturnType<typeof createTmc50xx>,
  bytes: number[],
): Uint8Array {
  const tx = Uint8Array.from(bytes)
  const rx = new Uint8Array(bytes.length)
  expect(chip.transfer(tx, rx, opts)).not.toBe(false)
  return rx
}

/** Zephyr tmc_spi_write_register — one 5-byte datagram. */
function spiWrite(chip: ReturnType<typeof createTmc50xx>, addr: number, value: number) {
  const word = value >>> 0
  xfer(chip, [
    tmc50xxMeta.WRITE_BIT | (addr & tmc50xxMeta.ADDRESS_MASK),
    (word >>> 24) & 0xff,
    (word >>> 16) & 0xff,
    (word >>> 8) & 0xff,
    word & 0xff,
  ])
}

/** Zephyr tmc_spi_read_register — address then data transfer. */
function spiRead(chip: ReturnType<typeof createTmc50xx>, addr: number): number {
  const cmd = addr & tmc50xxMeta.ADDRESS_MASK
  xfer(chip, [cmd, 0, 0, 0, 0])
  const rx = xfer(chip, [cmd, 0, 0, 0, 0])
  return ((rx[1]! << 24) | (rx[2]! << 16) | (rx[3]! << 8) | rx[4]!) >>> 0
}

describe('tmc50xx', () => {
  it('detects the chip shape', () => {
    const chip = createTmc50xx()
    expect(isTmc50xx(chip)).toBe(true)
    expect(isTmc50xx(null)).toBe(false)
    expect(chip.cs).toBe(0)
    expect(chip.motorCount).toBe(1)
  })

  it('writes and reads registers through the delayed SPI latch', () => {
    const chip = createTmc50xx()
    spiWrite(chip, tmc50xxMeta.REG_VMAX, 0x00123456)
    expect(spiRead(chip, tmc50xxMeta.REG_VMAX)).toBe(0x00123456)
    expect(chip.peek(tmc50xxMeta.REG_VMAX)).toBe(0x00123456)
  })

  it('starts standing still with STST set', () => {
    const chip = createTmc50xx()
    expect(spiRead(chip, tmc50xxMeta.REG_DRVSTATUS) & tmc50xxMeta.DRVSTATUS_STST).toBe(
      tmc50xxMeta.DRVSTATUS_STST,
    )
    expect(chip.getMotor().moving).toBe(false)
  })

  it('completes positioning on XTARGET write and sets POS_REACHED', () => {
    // Instant register arrive: qemu-wasm starves rAF, so the sample must see
    // RAMPSTAT on its first poll. The dock still eases (moving=true briefly).
    const chip = createTmc50xx()
    spiWrite(chip, tmc50xxMeta.REG_VMAX, 900_000)
    spiWrite(chip, tmc50xxMeta.REG_RAMPMODE, tmc50xxMeta.RAMPMODE_POSITIONING)
    spiWrite(chip, tmc50xxMeta.REG_XACTUAL, 0)
    spiWrite(chip, tmc50xxMeta.REG_XTARGET, 51200)

    expect(asSigned(chip.peek(tmc50xxMeta.REG_XACTUAL))).toBe(51200)
    const ramp = chip.peek(tmc50xxMeta.REG_RAMPSTAT)
    expect(ramp & tmc50xxMeta.RAMPSTAT_POS_REACHED).toBe(tmc50xxMeta.RAMPSTAT_POS_REACHED)
    expect(ramp & tmc50xxMeta.RAMPSTAT_POS_REACHED_EVENT).toBe(
      tmc50xxMeta.RAMPSTAT_POS_REACHED_EVENT,
    )
    expect(chip.peek(tmc50xxMeta.REG_DRVSTATUS) & tmc50xxMeta.DRVSTATUS_STST).toBe(
      tmc50xxMeta.DRVSTATUS_STST,
    )
    // Emerald dial while the display ease runs; guest already sees STST.
    expect(chip.getMotor().moving).toBe(true)
    expect(chip.getMotor().directionPositive).toBe(true)

    const viaSpi = spiRead(chip, tmc50xxMeta.REG_RAMPSTAT)
    expect(viaSpi & tmc50xxMeta.RAMPSTAT_POS_REACHED_EVENT).toBe(
      tmc50xxMeta.RAMPSTAT_POS_REACHED_EVENT,
    )
    expect(chip.peek(tmc50xxMeta.REG_RAMPSTAT) & tmc50xxMeta.RAMPSTAT_POS_REACHED_EVENT).toBe(0)
    expect(chip.peek(tmc50xxMeta.REG_RAMPSTAT) & tmc50xxMeta.RAMPSTAT_POS_REACHED).toBe(
      tmc50xxMeta.RAMPSTAT_POS_REACHED,
    )
  })

  it('enables the driver via CHOPCONF TOFF like the Zephyr enable path', () => {
    const chip = createTmc50xx()
    expect(chip.getMotor().enabled).toBe(false)
    spiWrite(chip, tmc50xxMeta.REG_CHOPCONF, 0x0000000f)
    expect(chip.getMotor().enabled).toBe(true)
    expect(spiRead(chip, tmc50xxMeta.REG_CHOPCONF) & 0xf).toBe(0xf)
  })

  it('exposes a register map for the dock inspector', () => {
    const chip = createTmc50xx()
    expect(chip.registers.length).toBeGreaterThan(10)
    expect(chip.registers.some((r) => r.name === 'XACTUAL')).toBe(true)
    chip.poke(tmc50xxMeta.REG_VMAX, 42)
    expect(chip.peek(tmc50xxMeta.REG_VMAX)).toBe(42)
  })
})

function asSigned(n: number): number {
  return n | 0
}
