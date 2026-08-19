import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/qemu_cortex_a53_lp5012.dts?raw'
import { createLp5012 } from '@/virtio/devices/chips/lp50xx'
import { isJhd1313Backlight } from '@/virtio/devices/chips/jhd1313'
import { deriveDeviceInventory, type Availability } from '@/deviceTopology'

const ALL: Availability = {
  gnss: true,
  bluetooth: true,
  gpio: true,
  audio: true,
  mic: true,
  net: true,
  i2c: true,
  spi: false,
  can: false,
  power: false,
  display: true,
  input: true,
  disk: false,
}

describe('lp5012 dock topology', () => {
  it('attaches an interactive rgb-led row (not skipped as JHD backlight)', () => {
    const chip = createLp5012({ address: 0x14 })
    expect(isJhd1313Backlight(chip)).toBe(false)

    const doc = parseDts(fixture)
    const insights = computeInsights(doc)
    expect(insights.panels.has('led')).toBe(true)
    expect(
      insights.i2cBuses.some((b) => b.bridged && b.slots.some((s) => s.chipId === 'lp5012')),
    ).toBe(true)

    const inv = deriveDeviceInventory(
      { name: 'lp5012.dts', doc, insights },
      [chip],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const rgb = inv.nodes.filter((n) => n.body === 'rgb-led')
    expect(rgb).toHaveLength(1)
    expect(rgb[0]).toMatchObject({
      presence: 'interactive',
      deviceClass: 'led',
      compatible: 'ti,lp5012',
    })
  })
})
