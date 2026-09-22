import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/esp32c3_devkitc_watchdog.dts?raw'
import { deriveDeviceInventory, type Availability } from '@/deviceTopology'

const NONE: Availability = {
  gnss: false,
  bluetooth: false,
  gpio: false,
  audio: false,
  mic: false,
  net: false,
  i2c: false,
  spi: false,
  can: false,
  power: false,
  watchdog: false,
  display: false,
  input: false,
  disk: false,
}

const inventory = (avail: Availability) => {
  const doc = parseDts(fixture)
  return deriveDeviceInventory(
    { name: 'watchdog.dts', doc, insights: computeInsights(doc) },
    [],
    [],
    avail,
    'esp32c3_devkitc',
  )
}

describe('watchdog dock topology', () => {
  it('lists only the enabled timer group, placed on TIMG0', () => {
    const doc = parseDts(fixture)
    expect(computeInsights(doc).watchdogs).toMatchObject([
      { controllerLabel: 'wdt0', address: 0x6001f048 },
    ])

    const rows = inventory({ ...NONE, watchdog: true }).nodes.filter(
      (n) => n.deviceClass === 'watchdog',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      presence: 'interactive',
      body: 'watchdog',
      watchdogIndex: 0,
      compatible: 'espressif,esp32-watchdog',
      panelKind: 'watchdog',
    })
  })

  it('stays inert until the emulator reports on it', () => {
    const rows = inventory(NONE).nodes.filter((n) => n.deviceClass === 'watchdog')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ presence: 'inert', body: undefined })
  })
})
