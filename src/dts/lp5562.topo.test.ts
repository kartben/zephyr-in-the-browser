import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/qemu_cortex_a53_lp5562.dts?raw'
import { createLp5562 } from '@/virtio/devices/chips/lp5562'
import { isJhd1313Backlight } from '@/virtio/devices/chips/jhd1313'
import { deriveDeviceInventory, type Availability } from '@/deviceTopology'

const ALL: Availability = {
  gnss: true,
  gpio: true,
  audio: true,
  mic: true,
  net: true,
  i2c: true,
  display: true,
  input: true,
}

describe('lp5562 dock topology', () => {
  it('attaches an interactive rgb-led row (not skipped as JHD backlight)', () => {
    const chip = createLp5562({ address: 0x30 })
    expect(isJhd1313Backlight(chip)).toBe(false)

    const doc = parseDts(fixture)
    const insights = computeInsights(doc)
    expect(insights.panels.has('led')).toBe(true)
    expect(
      insights.i2cBuses.some((b) => b.bridged && b.slots.some((s) => s.chipId === 'lp5562')),
    ).toBe(true)

    const inv = deriveDeviceInventory(
      { name: 'lp5562.dts', doc, insights },
      [chip],
      ALL,
      'qemu_cortex_a53',
    )
    const rgb = inv.nodes.filter((n) => n.body === 'rgb-led')
    expect(rgb).toHaveLength(1)
    expect(rgb[0]).toMatchObject({
      presence: 'interactive',
      deviceClass: 'led',
      compatible: 'ti,lp5562',
    })
  })
})
