import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/qemu_cortex_a53_pt6314.dts?raw'
import { createPt6314 } from '@/virtio/devices/chips/pt6314'
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

describe('pt6314 dock topology', () => {
  it('attaches an interactive auxdisplay row on SPI CS0', () => {
    const chip = createPt6314({ cs: 0, columns: 20, rows: 2 })

    const doc = parseDts(fixture)
    const insights = computeInsights(doc)
    expect(insights.panels.has('auxdisplay')).toBe(true)
    expect(insights.panels.has('spi')).toBe(true)
    expect(
      insights.spiBuses.some((b) => b.bridged && b.slots.some((s) => s.chipId === 'pt6314')),
    ).toBe(true)

    const inv = deriveDeviceInventory(
      { name: 'pt6314.dts', doc, insights },
      [],
      [chip],
      ALL,
      'qemu_cortex_a53',
    )
    const rows = inv.nodes.filter((n) => n.body === 'auxdisplay')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      presence: 'interactive',
      deviceClass: 'auxdisplay',
      compatible: 'ptc,pt6314',
    })
  })
})
