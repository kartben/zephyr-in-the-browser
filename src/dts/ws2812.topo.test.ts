import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/qemu_cortex_a53_ws2812.dts?raw'
import { createWs2812 } from '@/virtio/devices/chips/ws2812'
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
  display: true,
  input: true,
}

describe('ws2812 dock topology', () => {
  it('attaches an interactive rgb-led strip row on SPI CS0', () => {
    const chip = createWs2812({ cs: 0 })

    const doc = parseDts(fixture)
    const insights = computeInsights(doc)
    expect(insights.panels.has('led')).toBe(true)
    expect(insights.panels.has('spi')).toBe(true)
    expect(
      insights.spiBuses.some((b) => b.bridged && b.slots.some((s) => s.chipId === 'ws2812')),
    ).toBe(true)

    const inv = deriveDeviceInventory(
      { name: 'ws2812.dts', doc, insights },
      [],
      [chip],
      ALL,
      'qemu_cortex_a53',
    )
    const strip = inv.nodes.filter((n) => n.body === 'rgb-led')
    expect(strip).toHaveLength(1)
    expect(strip[0]).toMatchObject({
      presence: 'interactive',
      deviceClass: 'led',
      compatible: 'worldsemi,ws2812-spi',
      partId: 'ws2812',
    })
  })
})
