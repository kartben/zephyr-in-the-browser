import { describe, expect, it } from 'vitest'
import { computeInsights } from './insights'
import { parseDts } from './parser'
import m3Blinky from './fixtures/qemu_cortex_m3_blinky.dts?raw'
import a53Shell from './fixtures/qemu_cortex_a53_shell.dts?raw'
import a53Blinky from './fixtures/qemu_cortex_a53_blinky.dts?raw'
import twoBuses from './fixtures/two_i2c_buses.dts?raw'

const insightsOf = (src: string) => computeInsights(parseDts(src))

describe('computeInsights', () => {
  it('grounds the A53 shell build: eleven I²C chips, SPI NOR+VFD, no GPIO', () => {
    const insights = insightsOf(a53Shell)

    expect(insights.model).toBe('QEMU Cortex-A53')
    expect(insights.console).toBe('uart0')

    expect(insights.uartBuses.map((b) => [b.controllerLabel, b.role, b.slots.map((s) => s.chipId)])).toEqual([
      ['uart0', 'console', []],
      ['uart1', 'gnss', ['gnss']],
    ])

    expect(insights.i2cBuses).toHaveLength(1)
    const bus = insights.i2cBuses[0]
    expect(bus.controllerLabel).toBe('virtio_i2c0')
    expect(bus.bridged).toBe(true)
    expect(bus.slots.map((s) => [s.address, s.chipId])).toEqual([
      [0x3c, 'ssd1306'],
      [0x3e, 'jhd1313'],
      [0x40, 'ina219'],
      [0x44, 'isl29035'],
      [0x48, 'tmp112'],
      [0x49, 'lm75'],
      [0x50, 'at24'],
      [0x53, 'adxl345'],
      [0x5c, 'lps22hh'],
      [0x68, 'pcf8523'],
      [0x6a, 'lsm6dso'],
    ])

    expect(insights.spiBuses).toHaveLength(1)
    const spi = insights.spiBuses[0]
    expect(spi.controllerLabel).toBe('virtio_spi0')
    expect(spi.bridged).toBe(true)
    expect(spi.slots.map((s) => [s.cs, s.chipId])).toEqual([
      [0, 'w25q'],
      [1, 'pt6314'],
    ])

    // virtio_gpio0 is disabled in this build, so no controller and no panel.
    expect(insights.gpioControllers).toEqual([])
    expect(insights.panels.has('gpio')).toBe(false)
    expect(insights.panels.has('i2c')).toBe(true)
    expect(insights.panels.has('spi')).toBe(true)
    expect(insights.panels.has('auxdisplay')).toBe(true)
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
    expect(gpio.leds).toEqual([{ id: 4, label: 'Browser LED0', flags: 0 }])
    expect(gpio.buttons).toEqual([{ id: 0, label: 'Browser SW0', flags: 0 }])
    expect(insights.panels.has('gpio')).toBe(true)
  })

  it('discovers a gpio-buzzer on the bridged controller', () => {
    const insights = insightsOf(`
      /dts-v1/;
      / {
        aliases { buzzer0 = &buzzer0; };
        soc {
          virtio_gpio0: gpio@0 {
            compatible = "virtio,gpio";
            gpio-controller;
            #gpio-cells = <2>;
            ngpios = <8>;
            status = "okay";
          };
        };
        buzzer0: buzzer {
          compatible = "gpio-buzzer";
          gpios = <&virtio_gpio0 5 0>;
          label = "Browser buzzer";
        };
      };
    `)
    expect(insights.gpioControllers).toHaveLength(1)
    expect(insights.gpioControllers[0].buzzers).toEqual([
      { id: 5, label: 'Browser buzzer', activeHigh: true },
    ])
    expect(insights.panels.has('buzzer')).toBe(true)
    expect(insights.panels.has('gpio')).toBe(true)
  })

  it('discovers a gpio step/dir stepper on the bridged controller', () => {
    const insights = insightsOf(`
      /dts-v1/;
      / {
        aliases { stepper-ctrl = &browser_stepper; };
        soc {
          virtio_gpio0: gpio@0 {
            compatible = "virtio,gpio";
            gpio-controller;
            #gpio-cells = <2>;
            ngpios = <8>;
            status = "okay";
          };
        };
        browser_stepper: motion-controller {
          compatible = "zephyr,gpio-step-dir-stepper-ctrl";
          step-gpios = <&virtio_gpio0 6 0>;
          dir-gpios = <&virtio_gpio0 7 0>;
        };
      };
    `)
    expect(insights.gpioControllers).toHaveLength(1)
    expect(insights.gpioControllers[0].steppers).toEqual([
      {
        id: '/motion-controller',
        label: 'browser_stepper',
        stepPin: 6,
        stepActiveHigh: true,
        dirPin: 7,
        dirActiveHigh: true,
        invertDirection: false,
      },
    ])
    expect(insights.panels.has('stepper')).toBe(true)
    expect(insights.panels.has('gpio')).toBe(true)
  })

  it('marks invert-direction on a step/dir stepper', () => {
    const insights = insightsOf(`
      /dts-v1/;
      / {
        soc {
          virtio_gpio0: gpio@0 {
            compatible = "virtio,gpio";
            gpio-controller;
            #gpio-cells = <2>;
            ngpios = <8>;
            status = "okay";
          };
        };
        motion-controller {
          compatible = "zephyr,gpio-step-dir-stepper-ctrl";
          step-gpios = <&virtio_gpio0 6 0>;
          dir-gpios = <&virtio_gpio0 7 0>;
          invert-direction;
        };
      };
    `)
    expect(insights.gpioControllers[0].steppers[0]?.invertDirection).toBe(true)
  })

  it('marks led panel when bridged gpio-leds are present', () => {
    const insights = insightsOf(a53Blinky)
    expect(insights.gpioControllers[0]?.leds.length).toBeGreaterThan(0)
    expect(insights.panels.has('led')).toBe(true)
    expect(insights.panels.has('gpio')).toBe(true)
    expect(insights.panels.has('keys')).toBe(true)
  })

  it('discovers pwm-leds children on a PCA9685 controller', () => {
    const insights = insightsOf(`
      /dts-v1/;
      / {
        soc {
          i2c@0 {
            compatible = "virtio,i2c";
            #address-cells = <1>;
            #size-cells = <0>;
            status = "okay";
            pca9685_0: pca9685@60 {
              compatible = "nxp,pca9685-pwm";
              reg = <0x60>;
              #pwm-cells = <3>;
              status = "okay";
            };
          };
        };
        pwmleds {
          compatible = "pwm-leds";
          s_led0: s-led-0 {
            pwms = <&pca9685_0 0 20000000 0>;
            label = "PWM LED 0";
          };
          s_led1: s-led-1 {
            pwms = <&pca9685_0 1 20000000 0>;
            label = "PWM LED 1";
          };
        };
      };
    `)
    expect(insights.pwmLeds).toEqual([
      {
        channel: 0,
        label: 'PWM LED 0',
        periodNs: 20_000_000,
        inverted: false,
        controllerPath: '/soc/i2c@0/pca9685@60',
        controllerLabel: 'pca9685_0',
        groupPath: '/pwmleds',
        groupName: 'pwmleds',
      },
      {
        channel: 1,
        label: 'PWM LED 1',
        periodNs: 20_000_000,
        inverted: false,
        controllerPath: '/soc/i2c@0/pca9685@60',
        controllerLabel: 'pca9685_0',
        groupPath: '/pwmleds',
        groupName: 'pwmleds',
      },
    ])
    expect(insights.panels.has('led')).toBe(true)
    expect(insights.panels.has('pwm')).toBe(true)
  })

  it('grounds the M3 build on the MMIO bridge', () => {
    const insights = insightsOf(m3Blinky)

    expect(insights.gpioControllers).toHaveLength(1)
    const gpio = insights.gpioControllers[0]
    expect(gpio.controllerLabel).toBe('host_gpio')
    expect(gpio.compatible).toBe('qemu,host-gpio')
    expect(gpio.bridged).toBe(true)
    expect(gpio.leds).toEqual([{ id: 4, label: 'Host LED0', flags: 0 }])
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
    expect(insights.gpioControllers[1].leds).toEqual([{ id: 4, label: 'Bridge LED', flags: 0 }])
    expect(insights.gpioControllers[0].leds).toEqual([{ id: 17, label: 'On-chip LED', flags: 1 }])
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
