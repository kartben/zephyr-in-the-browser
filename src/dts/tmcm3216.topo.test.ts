import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/qemu_cortex_a53_tmcm3216.dts?raw'
import { deriveDeviceInventory, type Availability } from '@/deviceTopology'

const ALL: Availability = {
  gnss: true,
  gpio: true,
  audio: true,
  mic: true,
  net: true,
  i2c: false,
  spi: false,
  display: false,
  input: true,
}

describe('tmcm3216 dock topology', () => {
  it('nests TMCM under uart1 with a stepper body', () => {
    const doc = parseDts(fixture)
    const insights = computeInsights(doc)
    expect(insights.panels.has('stepper')).toBe(true)
    const uart1 = insights.uartBuses.find((b) => b.controllerLabel === 'uart1')
    expect(uart1?.role).toBe('tmcm3216')
    expect(uart1?.slots.some((s) => s.chipId === 'tmcm3216')).toBe(true)

    const inv = deriveDeviceInventory(
      { name: 'tmcm3216.dts', doc, insights },
      [],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const tmcm = inv.nodes.find((n) => n.key === 'tmcm3216')
    expect(tmcm).toBeDefined()
    expect(tmcm?.parentKey).toBe('uart1')
    expect(tmcm?.body).toBe('stepper')
    expect(tmcm?.deviceClass).toBe('stepper')
    expect(tmcm?.compatible).toBe('adi,tmcm3216')
  })
})
