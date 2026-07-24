import { describe, expect, it } from 'vitest'
import { parseDts } from './parser'
import {
  aliases,
  byLabel,
  chosen,
  compatibles,
  gpioSpecs,
  isOkay,
  numberProp,
  regAddress,
  statusOf,
  unitAddressNumber,
} from './query'
import m3Blinky from './fixtures/qemu_cortex_m3_blinky.dts?raw'
import a53Shell from './fixtures/qemu_cortex_a53_shell.dts?raw'

describe('query helpers', () => {
  it('resolves aliases through &label references', () => {
    const doc = parseDts(m3Blinky)
    const table = aliases(doc)
    expect(table.led0?.name).toBe('led_0')
    expect(table.gnss?.name).toBe('gnss-nmea-generic')
    expect(table.missing).toBeUndefined()
  })

  it('resolves aliases written as path strings', () => {
    const doc = parseDts(`
      /dts-v1/;
      / {
        aliases { console = "/soc/uart@0"; };
        soc { uart@0 { }; };
      };
    `)
    expect(aliases(doc).console?.name).toBe('uart@0')
  })

  it('resolves chosen entries', () => {
    const doc = parseDts(a53Shell)
    expect(chosen(doc)['zephyr,console']?.name).toBe('uart@9000000')
  })

  it('reads status with okay as the default', () => {
    const doc = parseDts(a53Shell)
    expect(isOkay(byLabel(doc, 'virtio_i2c0')!)).toBe(true)
    expect(isOkay(byLabel(doc, 'virtio_gpio0')!)).toBe(false)
    expect(statusOf(byLabel(doc, 'virtio_gpio0')!)).toBe('disabled')
    expect(isOkay(byLabel(doc, 'gnss')!)).toBe(true) // no status property
  })

  it('reads reg and unit addresses', () => {
    const doc = parseDts(a53Shell)
    expect(regAddress(byLabel(doc, 'tmp112_0')!)).toBe(0x48)
    expect(unitAddressNumber(byLabel(doc, 'ssd1306_0')!)).toBe(0x3c)
    // Falls back to the unit address when there is no reg.
    expect(regAddress(byLabel(doc, 'ramfb0')!)).toBeUndefined()
    expect(numberProp(byLabel(doc, 'virtio_gpio0')!, 'ngpios')).toBe(8)
  })

  it('decodes gpios specs against the controller cell width', () => {
    const doc = parseDts(m3Blinky)
    const led = byLabel(doc, 'led0')!
    expect(gpioSpecs(doc, led)).toEqual([
      {
        controller: byLabel(doc, 'host_gpio'),
        controllerLabel: 'host_gpio',
        pin: 4,
        flags: 0,
      },
    ])
  })

  it('keeps the written label when a gpios ref resolves nowhere', () => {
    const doc = parseDts('/dts-v1/; / { l { gpios = <&nowhere 7 1>; }; };')
    const specs = gpioSpecs(doc, doc.root.children[0])
    expect(specs).toEqual([
      { controller: undefined, controllerLabel: 'nowhere', pin: 7, flags: 1 },
    ])
  })

  it('lists compatibles', () => {
    const doc = parseDts(a53Shell)
    expect(compatibles(byLabel(doc, 'tmp112_0')!)).toEqual(['ti,tmp112'])
  })
})
