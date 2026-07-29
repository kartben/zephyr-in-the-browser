import { describe, expect, it } from 'vitest'
import {
  marksFromGpioEdges,
  marksFromI2c,
  marksFromSpi,
  peripheralWindowStats,
  reconstructPeripheralLanes,
  type PeripheralMark,
} from './peripheralActivity'

const mapHost = (ms: number) => ms * 1e6

describe('marksFromI2c / Spi / GPIO', () => {
  it('builds I²C marks with chip labels', () => {
    const marks = marksFromI2c(
      [
        {
          id: 1,
          address: 0x48,
          dir: 'read',
          bytes: new Uint8Array([0, 1]),
          byteLength: 2,
          ok: true,
          chip: 'TMP112 Thermometer',
          atMs: 10,
        },
        {
          id: 2,
          address: 0x40,
          dir: 'write',
          bytes: new Uint8Array([0]),
          byteLength: 1,
          ok: false,
          chip: null,
          atMs: 20,
        },
      ],
      mapHost,
    )
    expect(marks).toHaveLength(2)
    expect(marks[0]).toMatchObject({
      ts: 10e6,
      bus: 'i2c',
      laneKey: 'i2c:48',
      label: 'TMP112',
      ok: true,
      bytes: 2,
    })
    expect(marks[1]).toMatchObject({
      laneKey: 'i2c:40',
      label: '0x40',
      ok: false,
    })
  })

  it('builds SPI marks by chip-select', () => {
    const marks = marksFromSpi(
      [
        {
          id: 1,
          cs: 0,
          tx: new Uint8Array([1]),
          rx: new Uint8Array([2]),
          byteLength: 4,
          ok: true,
          chip: 'W25Q Flash',
          csChange: true,
          atMs: 5,
        },
      ],
      mapHost,
    )
    expect(marks[0]).toMatchObject({
      bus: 'spi',
      laneKey: 'spi:0',
      label: 'W25Q',
      bytes: 4,
    })
  })

  it('drops marks when the host→guest map returns null', () => {
    expect(
      marksFromI2c(
        [
          {
            id: 1,
            address: 0x48,
            dir: 'read',
            bytes: new Uint8Array(),
            byteLength: 0,
            ok: true,
            chip: 'TMP112',
            atMs: 1,
          },
        ],
        () => null,
      ),
    ).toEqual([])
  })

  it('builds a single GPIO lane from output edges', () => {
    const marks = marksFromGpioEdges(
      [
        { atMs: 1, word: 0x10, changed: 0x10 },
        { atMs: 2, word: 0x00, changed: 0x10 },
      ],
      mapHost,
    )
    expect(marks).toHaveLength(2)
    expect(marks.every((m) => m.laneKey === 'gpio:out')).toBe(true)
  })
})

describe('reconstructPeripheralLanes', () => {
  const marks: PeripheralMark[] = [
    {
      ts: 100,
      atMs: 1,
      bus: 'i2c',
      laneKey: 'i2c:48',
      label: 'TMP112',
      detail: 'read 0x48',
      ok: true,
      bytes: 2,
    },
    {
      ts: 200,
      atMs: 2,
      bus: 'i2c',
      laneKey: 'i2c:48',
      label: 'TMP112',
      detail: 'read 0x48',
      ok: true,
      bytes: 2,
    },
    {
      ts: 150,
      atMs: 1.5,
      bus: 'spi',
      laneKey: 'spi:0',
      label: 'W25Q',
      detail: 'CS0 · 4 B',
      ok: true,
      bytes: 4,
    },
    {
      ts: 50,
      atMs: 0.5,
      bus: 'gpio',
      laneKey: 'gpio:out',
      label: 'GPIO',
      detail: 'out 0x10',
      ok: true,
    },
    {
      ts: 9_000,
      atMs: 90,
      bus: 'i2c',
      laneKey: 'i2c:48',
      label: 'TMP112',
      detail: 'read 0x48',
      ok: true,
      bytes: 2,
    },
  ]

  it('groups by lane and clips to the window', () => {
    const lanes = reconstructPeripheralLanes(marks, 0, 300)
    expect(lanes.map((l) => l.key)).toEqual(['i2c:48', 'spi:0', 'gpio:out'])
    expect(lanes[0]!.marks).toHaveLength(2)
    expect(lanes[1]!.marks).toHaveLength(1)
    expect(lanes[2]!.marks).toHaveLength(1)
  })

  it('summarises window stats', () => {
    const lanes = reconstructPeripheralLanes(marks, 0, 300)
    expect(peripheralWindowStats(lanes)).toEqual({
      lanes: 3,
      marks: 4,
      bytes: 8,
      buses: { i2c: 2, spi: 1, gpio: 1 },
    })
  })
})
