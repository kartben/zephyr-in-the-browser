import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/qemu_cortex_a53_sct2024.dts?raw'
import { createSct2024 } from '@/virtio/devices/chips/sct2024'
import { deriveDeviceInventory, type Availability } from '@/deviceTopology'

const ALL: Availability = {
  gnss: true,
  bluetooth: true,
  gpio: true,
  audio: true,
  mic: true,
  net: true,
  i2c: false,
  spi: true,
  can: false,
  power: false,
  display: true,
  input: true,
  disk: false,
}

describe('sct2024 dock topology', () => {
  it('attaches an interactive led-bar row on SPI CS0', () => {
    const chip = createSct2024({ cs: 0 })

    const doc = parseDts(fixture)
    const insights = computeInsights(doc)
    expect(insights.panels.has('led')).toBe(true)
    expect(insights.panels.has('spi')).toBe(true)
    expect(
      insights.spiBuses.some((b) => b.bridged && b.slots.some((s) => s.chipId === 'sct2024')),
    ).toBe(true)

    const inv = deriveDeviceInventory(
      { name: 'sct2024.dts', doc, insights },
      [],
      [chip],
      ALL,
      'qemu_cortex_a53',
    )
    const bar = inv.nodes.filter((n) => n.body === 'led-bar')
    expect(bar).toHaveLength(1)
    expect(bar[0]).toMatchObject({
      presence: 'interactive',
      deviceClass: 'led',
      compatible: 'sct,sct2024',
    })
  })
})
