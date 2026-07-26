import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/qemu_cortex_a53_tmc50xx.dts?raw'
import { createTmc50xx } from '@/virtio/devices/chips/tmc50xx'
import { deriveDeviceInventory, type Availability } from '@/deviceTopology'

const ALL: Availability = {
  gnss: true,
  gpio: true,
  audio: true,
  mic: true,
  net: true,
  i2c: false,
  spi: true,
  display: true,
  input: true,
}

describe('tmc50xx dock topology', () => {
  it('attaches an interactive stepper-tmc row on SPI CS0', () => {
    const chip = createTmc50xx({ cs: 0 })

    const doc = parseDts(fixture)
    const insights = computeInsights(doc)
    expect(insights.panels.has('stepper')).toBe(true)
    expect(insights.panels.has('spi')).toBe(true)
    expect(
      insights.spiBuses.some((b) => b.bridged && b.slots.some((s) => s.chipId === 'tmc50xx')),
    ).toBe(true)

    const inv = deriveDeviceInventory(
      { name: 'tmc50xx.dts', doc, insights },
      [],
      [chip],
      ALL,
      'qemu_cortex_a53',
    )
    const steppers = inv.nodes.filter((n) => n.body === 'stepper-tmc')
    expect(steppers).toHaveLength(1)
    expect(steppers[0]).toMatchObject({
      presence: 'interactive',
      deviceClass: 'stepper',
      compatible: 'adi,tmc50xx',
      partId: 'tmc50xx',
      panelKind: 'stepper',
    })
  })
})
