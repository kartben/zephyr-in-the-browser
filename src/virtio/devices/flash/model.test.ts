/**
 * Unit tests for the shared JEDEC SPI NOR machine — geometry constraints,
 * session counters, and occupancy/wear tracking that the flash card consumes.
 */

import { describe, expect, it } from 'vitest'
import {
  createSpiFlashChip,
  flashTotalErases,
  flashUsedFraction,
  formatFlashCount,
  formatFlashSize,
  type SpiFlashDecl,
} from './model'

const JEDEC = Uint8Array.of(0xef, 0x40, 0x13)

const tinyDecl: SpiFlashDecl = {
  name: 'tiny NOR',
  defaultCs: 0,
  size: 8192,
  pageSize: 256,
  sectorSize: 4096,
  blockEraseSizes: [32 * 1024, 64 * 1024],
  jedecId: JEDEC,
  erased: 0xff,
  enduranceCycles: 1000,
}

function xfer(
  chip: ReturnType<typeof createSpiFlashChip>,
  tx: number[],
  csChange = true,
): Uint8Array {
  const txBytes = Uint8Array.from(tx)
  const rx = new Uint8Array(txBytes.length)
  chip.transfer(txBytes, rx, {
    csChange,
    bitsPerWord: 8,
    mode: 0,
    freq: 1_000_000,
  })
  return rx
}

describe('createSpiFlashChip stats + constraints', () => {
  it('tracks read ops/bytes and occupancy after program', () => {
    const chip = createSpiFlashChip(tinyDecl)
    xfer(chip, [0x06]) // WREN
    xfer(chip, [0x02, 0x00, 0x00, 0x10, 0xde, 0xad, 0xbe, 0xef])

    const afterProg = chip.stats()
    expect(afterProg.programOps).toBe(1)
    expect(afterProg.programBytes).toBe(4)
    expect(afterProg.usedBytes).toBe(4)
    expect(afterProg.dirtySectors).toBe(1)
    expect(flashUsedFraction(afterProg, tinyDecl.size)).toBeCloseTo(4 / 8192)

    const rx = xfer(chip, [0x03, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00])
    expect(Array.from(rx.slice(4))).toEqual([0xde, 0xad, 0xbe, 0xef])

    const afterRead = chip.stats()
    expect(afterRead.readOps).toBe(1)
    expect(afterRead.readBytes).toBe(4)
  })

  it('only clears bits on program (NOR constraint)', () => {
    const chip = createSpiFlashChip(tinyDecl)
    xfer(chip, [0x06])
    xfer(chip, [0x02, 0x00, 0x00, 0x00, 0xff, 0x0f])
    expect(chip.memory[1]).toBe(0x0f)

    xfer(chip, [0x06])
    // Attempt to set high bits again — program can only clear.
    xfer(chip, [0x02, 0x00, 0x00, 0x01, 0xf0])
    expect(chip.memory[1]).toBe(0x00)
  })

  it('requires WEL before program or erase', () => {
    const chip = createSpiFlashChip(tinyDecl)
    xfer(chip, [0x02, 0x00, 0x00, 0x00, 0xaa])
    expect(chip.memory[0]).toBe(0xff)
    expect(chip.stats().programBytes).toBe(0)

    xfer(chip, [0x20, 0x00, 0x00, 0x00])
    expect(chip.stats().sectorErases).toBe(0)
  })

  it('wraps page program within pageSize', () => {
    const chip = createSpiFlashChip(tinyDecl)
    xfer(chip, [0x06])
    // Start at 0xfe — two bytes wrap to 0x00/0x01 of the same 256 B page.
    xfer(chip, [0x02, 0x00, 0x00, 0xfe, 0x11, 0x22, 0x33])
    expect(chip.memory[0xfe]).toBe(0x11)
    expect(chip.memory[0xff]).toBe(0x22)
    expect(chip.memory[0x00]).toBe(0x33)
  })

  it('counts sector erases and wear per sector', () => {
    const chip = createSpiFlashChip(tinyDecl)
    xfer(chip, [0x06])
    xfer(chip, [0x02, 0x00, 0x10, 0x00, 0xaa]) // sector 1
    expect(chip.stats().dirtySectors).toBe(1)

    xfer(chip, [0x06])
    xfer(chip, [0x20, 0x00, 0x10, 0x00]) // SE sector 1
    const s = chip.stats()
    expect(s.sectorErases).toBe(1)
    expect(s.sectorEraseCounts[1]).toBe(1)
    expect(s.sectorEraseCounts[0]).toBe(0)
    expect(s.usedBytes).toBe(0)
    expect(s.dirtySectors).toBe(0)
    expect(flashTotalErases(s)).toBe(1)
  })

  it('resetStats clears counters and wear without wiping the image', () => {
    const chip = createSpiFlashChip(tinyDecl)
    xfer(chip, [0x06])
    xfer(chip, [0x02, 0x00, 0x00, 0x00, 0x55])
    xfer(chip, [0x06])
    xfer(chip, [0x20, 0x00, 0x00, 0x00])
    xfer(chip, [0x06])
    xfer(chip, [0x02, 0x00, 0x00, 0x00, 0xaa])

    chip.resetStats()
    const s = chip.stats()
    expect(s.readOps).toBe(0)
    expect(s.programOps).toBe(0)
    expect(s.sectorErases).toBe(0)
    expect(s.maxSectorErases).toBe(0)
    expect(chip.memory[0]).toBe(0xaa)
    expect(s.usedBytes).toBe(1)
  })

  it('ignores block-erase opcodes when not in blockEraseSizes', () => {
    const noBlock = createSpiFlashChip({
      ...tinyDecl,
      blockEraseSizes: [],
    })
    noBlock.poke(0, 0x12)
    xfer(noBlock, [0x06])
    xfer(noBlock, [0x52, 0x00, 0x00, 0x00]) // BE 32K
    expect(noBlock.memory[0]).toBe(0x12)
    expect(noBlock.stats().blockErases32k).toBe(0)
  })
})

describe('flash format helpers', () => {
  it('formats counts and sizes', () => {
    expect(formatFlashCount(42)).toBe('42')
    expect(formatFlashCount(1200)).toBe('1.2K')
    expect(formatFlashCount(12_000)).toBe('12K')
    expect(formatFlashSize(256)).toBe('256 B')
    expect(formatFlashSize(4096)).toBe('4 KiB')
    expect(formatFlashSize(1024 * 1024)).toBe('1 MiB')
  })
})
