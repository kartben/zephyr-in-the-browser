import { describe, expect, it } from 'vitest'
import { computeInsights } from './insights'
import { parseDts } from './parser'
import m3Blinky from './fixtures/qemu_cortex_m3_blinky.dts?raw'
import a53Shell from './fixtures/qemu_cortex_a53_shell.dts?raw'
import a53Blinky from './fixtures/qemu_cortex_a53_blinky.dts?raw'
import twoBuses from './fixtures/two_i2c_buses.dts?raw'

const insightsOf = (src: string) => computeInsights(parseDts(src))

describe('computeInsights', () => {
  it('grounds the A53 shell build: six chips, no GPIO', () => {
    const insights = insightsOf(a53Shell)

    expect(insights.model).toBe('QEMU Cortex-A53')
    expect(insights.console).toBe('uart0')

    expect(insights.i2cBuses).toHaveLength(1)
    const bus = insights.i2cBuses[0]
    expect(bus.controllerLabel).toBe('virtio_i2c0')
    expect(bus.bridged).toBe(true)
    expect(bus.slots.map((s) => [s.address, s.chipId])).toEqual([
      [0x3c, 'ssd1306'],
      [0x48, 'tmp112'],
      [0x49, 'lm75'],
      [0x50, 'at24'],
      [0x53, 'adxl345'],
      [0x6a, 'lsm6dso'],
    ])

    // virtio_gpio0 is disabled in this build, so no controller and no panel.
    expect(insights.gpioControllers).toEqual([])
    expect(insights.panels.has('gpio')).toBe(false)
    expect(insights.panels.has('i2c')).toBe(true)
    expect(insights.panels.has('sensor')).toBe(true)
    expect(insights.panels.has('display')).toBe(true) // ramfb okay
    expect(insights.panels.has('oled')).toBe(false) // zephyr,display not chosen
    expect(insights.panels.has('net')).toBe(true)
    expect(insights.panels.has('gnss')).toBe(true)
    expect(insights.panels.has('audio')).toBe(true)

    expect(insights.aliases.accel0).toBe('/soc/virtio_mmio@a000800/virtio-i2c/adxl345@53')
    expect(insights.memory).toEqual([{ base: 0x40000000, bytes: 0x8000000 }])
  })

  it('grounds the A53 blinky build: GPIO pins, no I2C', () => {
    const insights = insightsOf(a53Blinky)

    // The bus node exists but is disabled — that is the negative signal.
    expect(insights.i2cBuses).toEqual([])
    expect(insights.panels.has('i2c')).toBe(false)
    expect(insights.panels.has('sensor')).toBe(false)
    expect(insights.panels.has('oled')).toBe(false)

    expect(insights.gpioControllers).toHaveLength(1)
    const gpio = insights.gpioControllers[0]
    expect(gpio.controllerLabel).toBe('virtio_gpio0')
    expect(gpio.bridged).toBe(true)
    expect(gpio.ngpios).toBe(8)
    expect(gpio.leds).toEqual([{ id: 4, label: 'Browser LED0' }])
    expect(gpio.buttons).toEqual([{ id: 0, label: 'Browser SW0' }])
    expect(insights.panels.has('gpio')).toBe(true)
  })

  it('grounds the M3 build on the MMIO bridge', () => {
    const insights = insightsOf(m3Blinky)

    expect(insights.gpioControllers).toHaveLength(1)
    const gpio = insights.gpioControllers[0]
    expect(gpio.controllerLabel).toBe('host_gpio')
    expect(gpio.compatible).toBe('qemu,host-gpio')
    expect(gpio.bridged).toBe(true)
    expect(gpio.leds).toEqual([{ id: 4, label: 'Host LED0' }])
    expect(insights.panels.has('net')).toBe(true) // stellaris ethernet
    expect(insights.panels.has('i2c')).toBe(false) // no bus on this machine
  })

  it('enumerates every controller but bridges only the page ones', () => {
    const insights = insightsOf(twoBuses)

    expect(insights.i2cBuses.map((b) => [b.controllerLabel, b.bridged])).toEqual([
      ['i2c0', false],
      ['virtio_i2c0', true],
    ])
    // The on-chip bus is listed with its chip, but no page model claims it.
    expect(insights.i2cBuses[0].slots).toEqual([
      { address: 0x76, compatible: 'bosch,bme280', chipId: undefined, nodeName: 'bme280@76' },
    ])
    // Disabled chips never become slots.
    expect(insights.i2cBuses[1].slots.map((s) => s.address)).toEqual([0x48])

    expect(
      insights.gpioControllers.map((c) => [c.controllerLabel, c.bridged, c.leds.length]),
    ).toEqual([
      ['soc_gpio', false, 1],
      ['virtio_gpio0', true, 1],
    ])
    // Each LED lands on the controller its own spec references.
    expect(insights.gpioControllers[1].leds).toEqual([{ id: 4, label: 'Bridge LED' }])
    expect(insights.gpioControllers[0].leds).toEqual([{ id: 17, label: 'On-chip LED' }])
  })

  it('spots an OLED chosen as the display', () => {
    const insights = insightsOf(`
      /dts-v1/;
      / {
        chosen { zephyr,display = &oled; };
        i2c@0 {
          #address-cells = <1>;
          #size-cells = <0>;
          oled: ssd1306@3c { compatible = "solomon,ssd1306"; reg = <0x3c>; };
        };
      };
    `)
    expect(insights.panels.has('oled')).toBe(true)
    expect(insights.panels.has('display')).toBe(false)
  })
})
