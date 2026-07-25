import { describe, expect, it } from 'vitest'
import {
  estimateRuntimeMins,
  formatSocPct,
  isFuelGaugeChip,
  voltageFraction,
} from '../fuel-gauge/model'
import { createMax17048, isMax17048, max17048Codec } from './max17048'

describe('MAX17048 fuel gauge', () => {
  it('is a FuelGaugeChip with VERSION the Zephyr probe accepts', () => {
    const chip = createMax17048()
    expect(isFuelGaugeChip(chip)).toBe(true)
    expect(isMax17048(chip)).toBe(true)
    expect(chip.getReg(0x08) & 0xfff0).toBe(0x0010)
  })

  it('encodes SoC / VCELL / CRATE the way the Zephyr driver decodes', () => {
    expect(max17048Codec.rawToSoc(0x3525)).toBe(0x35)
    expect(max17048Codec.socToRaw(75)).toBe(0x4b00)

    const uv = max17048Codec.rawToVoltageUv(0x4387)
    // Zephyr: raw * 78125 / 1000
    expect(uv).toBe(Math.round(0x4387 * 78.125))

    const crate = max17048Codec.rawToCrate(0xffd0)
    // 0xffd0 as int16 = -48; * 0.208 ≈ -9.984
    expect(crate).toBeCloseTo(-48 * 0.208, 5)
  })

  it('answers VCELL / SOC / CRATE over I²C as big-endian words', () => {
    const chip = createMax17048({ socPct: 72, voltageMv: 3968, cratePctPerHour: -10 })
    chip.write!(new Uint8Array([0x04]))
    const soc = chip.read!(2)!
    expect((soc[0]! << 8) | soc[1]!).toBe(max17048Codec.socToRaw(72))

    chip.write!(new Uint8Array([0x02]))
    const vcell = chip.read!(2)!
    const rawV = (vcell[0]! << 8) | vcell[1]!
    expect(max17048Codec.rawToVoltageUv(rawV) / 1000).toBeCloseTo(3968, 0)

    chip.write!(new Uint8Array([0x16]))
    const crate = chip.read!(2)!
    const rawC = (crate[0]! << 8) | crate[1]!
    expect(max17048Codec.rawToCrate(rawC)).toBeCloseTo(-10, 1)
  })

  it('lets the page drive SoC / voltage / rate for the guest to read', () => {
    const chip = createMax17048()
    chip.setSocPct(42)
    chip.setVoltageMv(3500)
    chip.setCratePctPerHour(12)
    const r = chip.getReading()
    expect(r.socPct).toBe(42)
    expect(r.voltageUv / 1000).toBeCloseTo(3500, 0)
    expect(r.cratePctPerHour).toBeCloseTo(12, 0)
    expect(r.charging).toBe(true)
  })

  it('POR command restores defaults', () => {
    const chip = createMax17048({ socPct: 10 })
    chip.setSocPct(1)
    chip.write!(new Uint8Array([0xfe, 0x54, 0x00]))
    expect(chip.getReading().socPct).toBe(10)
  })

  it('formats and estimates runtimes', () => {
    expect(formatSocPct(72.4)).toBe('72%')
    expect(voltageFraction(3_700_000, { vEmptyMv: 3000, vFullMv: 4200 })).toBeCloseTo(
      (3700 - 3000) / (4200 - 3000),
      5,
    )
    const runtime = estimateRuntimeMins({
      socPct: 50,
      voltageUv: 3_700_000,
      cratePctPerHour: -10,
      charging: false,
    })
    expect(runtime.toEmpty).toBeCloseTo(300, 5)
    expect(runtime.toFull).toBe(0)
  })
})
