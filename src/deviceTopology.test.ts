import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import type { I2cChip } from '@/virtio/devices/i2c'
import { createPca9685 } from '@/virtio/devices/chips/pca9685'
import { createJhd1313Pair } from '@/virtio/devices/chips/jhd1313'
import a53Shell from '@/dts/fixtures/qemu_cortex_a53_shell.dts?raw'
import a53Blinky from '@/dts/fixtures/qemu_cortex_a53_blinky.dts?raw'
import twoBuses from '@/dts/fixtures/two_i2c_buses.dts?raw'
import type { Availability, DeviceInventory, Row } from './deviceTopology'
import { buildRowList, deriveDeviceInventory } from './deviceTopology'

const treeOf = (text: string, name = 'test.dts') => {
  const doc = parseDts(text)
  return { name, doc, insights: computeInsights(doc) }
}

const ALL: Availability = {
  gnss: true,
  gpio: true,
  audio: true,
  mic: true,
  net: true,
  i2c: true,
  spi: false,
  display: true,
  input: true,
}

/* Fakes carrying just the duck-type markers the classifiers look for. */
const fakeSensor = (address: number, name: string): I2cChip =>
  ({ address, name, decl: {}, setChannel() {} }) as unknown as I2cChip
const fakeMemory = (address: number, name: string): I2cChip =>
  ({
    address,
    name,
    decl: {},
    poke() {},
    erase() {},
    version: () => 0,
    stats: () => ({
      readOps: 0,
      readBytes: 0,
      writeOps: 0,
      writeBytes: 0,
      usedBytes: 0,
      dirtyPages: 0,
      pageCount: 0,
      pageWriteCounts: new Uint32Array(0),
      pageUsedBytes: new Uint32Array(0),
      maxPageWrites: 0,
    }),
    resetStats() {},
  }) as unknown as I2cChip
const fakeRtc = (address: number, name: string): I2cChip =>
  ({
    address,
    name,
    decl: {},
    registers: [],
    getTime() {},
    syncFromBrowser() {},
    getAlarms() {
      return []
    },
    peek: () => 0,
    getPointer: () => 0,
    poke() {},
    setField() {},
    subscribe: () => () => {},
  }) as unknown as I2cChip
const fakeOled = (address: number, name: string): I2cChip =>
  ({ address, name, memory: new Uint8Array(0), isOn: () => true }) as unknown as I2cChip

const A53_DEFAULT_CHIPS: I2cChip[] = [
  fakeOled(0x3c, 'SSD1306 OLED'),
  fakeSensor(0x48, 'TMP112 temperature'),
  fakeSensor(0x49, 'LM75 temperature'),
  fakeMemory(0x50, 'AT24C02 EEPROM'),
  fakeSensor(0x53, 'ADXL345 accelerometer'),
]

/** Shell with i2c-sensors-extra + auxdisplays: defaults plus optional parts. */
const jhd1313Pair = createJhd1313Pair()
const A53_SHELL_CHIPS: I2cChip[] = [
  ...A53_DEFAULT_CHIPS,
  fakeSensor(0x40, 'INA219 power monitor'),
  fakeSensor(0x44, 'ISL29035 light'),
  fakeSensor(0x5c, 'LPS22HH pressure'),
  fakeRtc(0x68, 'PCF8523 RTC'),
  fakeSensor(0x6a, 'LSM6DSO IMU'),
  jhd1313Pair.lcd,
  jhd1313Pair.backlight,
]

const nodeByKey = (inv: DeviceInventory, key: string) => {
  const node = inv.nodes.find((n) => n.key === key)
  expect(node, `expected a node with key ${key}`).toBeDefined()
  return node!
}

const deviceKeys = (rows: Row[]) =>
  rows.flatMap((row) => (row.kind === 'device' ? [row.node.key] : []))

describe('deriveDeviceInventory from a devicetree', () => {
  it('grounds the A53 shell tree: live bus, chips, gnss under its uart', () => {
    const inv = deriveDeviceInventory(treeOf(a53Shell, 'shell.dts'), A53_SHELL_CHIPS, [], ALL, 'qemu_cortex_a53')

    expect(inv.source).toBe('devicetree')
    expect(inv.rootName).toBe('QEMU Cortex-A53')

    const bus = nodeByKey(inv, 'virtio_i2c0')
    expect(bus.presence).toBe('interactive')
    expect(bus.body).toBe('i2c')
    expect(bus.nodeName).toBe('virtio-i2c')

    // All eleven declared chips, in address order, named by their DT nodes.
    // Backlight @0x62 is not a DT child (backlight-addr on the LCD node).
    const chipRows = inv.nodes.filter((n) => n.parentKey === 'virtio_i2c0')
    expect(chipRows.map((n) => n.key)).toEqual([
      'virtio_i2c0:3c',
      'virtio_i2c0:3e',
      'virtio_i2c0:40',
      'virtio_i2c0:44',
      'virtio_i2c0:48',
      'virtio_i2c0:49',
      'virtio_i2c0:50',
      'virtio_i2c0:53',
      'virtio_i2c0:5c',
      'virtio_i2c0:68',
      'virtio_i2c0:6a',
    ])
    const tmp = nodeByKey(inv, 'virtio_i2c0:48')
    expect(tmp.nodeName).toBe('tmp112@48')
    expect(tmp.compatible).toBe('ti,tmp112')
    expect(tmp.deviceClass).toBe('sensor')
    expect(tmp.body).toBe('sensor')
    expect(tmp.crumb).toBe('virtio_i2c0 · 0x48')
    expect(nodeByKey(inv, 'virtio_i2c0:50').deviceClass).toBe('memory')
    expect(nodeByKey(inv, 'virtio_i2c0:3c').body).toBe('oled')
    expect(nodeByKey(inv, 'virtio_i2c0:3e').body).toBe('auxdisplay')
    expect(nodeByKey(inv, 'virtio_i2c0:3e').deviceClass).toBe('auxdisplay')
    expect(nodeByKey(inv, 'virtio_i2c0:68').deviceClass).toBe('rtc')
    expect(nodeByKey(inv, 'virtio_i2c0:68').body).toBe('rtc')

    // The ⌗ story: the GNSS receiver hangs off uart1, not off thin air.
    const gnss = nodeByKey(inv, 'gnss')
    const uart = inv.nodes.find((n) => n.key === gnss.parentKey)
    expect(uart?.nodeName).toBe('uart@9040000')
    expect(uart?.deviceClass).toBe('uart-bus')
    expect(uart?.key).toBe('uart1')
    expect(uart?.presence).toBe('interactive')
    expect(uart?.body).toBe('uart')
    expect(uart?.busLabel).toBe('uart1')

    expect(nodeByKey(inv, 'uart0').note).toBe('→ terminal')
    expect(nodeByKey(inv, 'uart0').deviceClass).toBe('uart-bus')
    expect(nodeByKey(inv, 'uart0').presence).toBe('inert')
    expect(nodeByKey(inv, 'display').note).toBe('on stage')
    expect(nodeByKey(inv, 'display').nodeName).toBe('ramfb')
    expect(nodeByKey(inv, 'net').nodeName).toBe('virtio-net')

    // virtio_gpio0 is disabled in this build: no controller, no row.
    expect(inv.nodes.some((n) => n.deviceClass === 'gpio')).toBe(false)
  })

  it('shows declared-but-unanswered slots as ghosts', () => {
    const inv = deriveDeviceInventory(treeOf(a53Shell), [], [], ALL, 'qemu_cortex_a53')

    const ghosts = inv.nodes.filter((n) => n.presence === 'ghost')
    expect(ghosts).toHaveLength(11)
    expect(ghosts.every((n) => n.note === 'NAK — detached')).toBe(true)

    // A detached declared sensor still files under Sensors, as a ghost.
    const tmp = nodeByKey(inv, 'virtio_i2c0:48')
    expect(tmp.presence).toBe('ghost')
    expect(tmp.deviceClass).toBe('sensor')
    expect(tmp.nodeName).toBe('tmp112@48')
  })

  it('tags a chip attached where the tree declares nothing as bus only', () => {
    const inv = deriveDeviceInventory(
      treeOf(a53Shell),
      [fakeSensor(0x60, 'FakeTemp sensor')],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const stray = nodeByKey(inv, 'virtio_i2c0:60')
    expect(stray.presence).toBe('interactive')
    expect(stray.tag).toBe('bus only')
    expect(stray.nodeName).toBe('faketemp@60')
  })

  it('lists a second, unbridged bus inert with its slots beneath it', () => {
    const inv = deriveDeviceInventory(
      treeOf(twoBuses),
      [fakeSensor(0x48, 'TMP112 temperature')],
      [],
      ALL,
      'qemu_cortex_a53',
    )

    const onChip = nodeByKey(inv, 'i2c0')
    expect(onChip.presence).toBe('inert')
    expect(onChip.note).toBe('no page model')
    const bme = nodeByKey(inv, 'i2c0:76')
    expect(bme.presence).toBe('inert')
    expect(bme.parentKey).toBe('i2c0')
    expect(bme.nodeName).toBe('bme280@76')

    const bridged = nodeByKey(inv, 'virtio_i2c0')
    expect(bridged.presence).toBe('interactive')
    expect(nodeByKey(inv, 'virtio_i2c0:48').presence).toBe('interactive')

    // The disabled mcp9808@18 must not surface at all.
    expect(inv.nodes.some((n) => n.nodeName.startsWith('mcp9808'))).toBe(false)

    // Two GPIO controllers: the bridged one is live, the on-chip one inert.
    expect(nodeByKey(inv, 'gpio').presence).toBe('interactive')
    expect(nodeByKey(inv, 'gpio:soc_gpio').note).toBe('no page model')
  })

  it('lists bridged surfaces as inert until the runtime exposes them', () => {
    const inv = deriveDeviceInventory(
      treeOf(a53Shell),
      A53_SHELL_CHIPS,
      [],
      { ...ALL, i2c: false, gnss: false },
      'qemu_cortex_a53',
    )
    const bus = nodeByKey(inv, 'virtio_i2c0')
    expect(bus.presence).toBe('inert')
    expect(bus.body).toBeUndefined()
    // Declared chips keep their seats (and keys) so the list does not reshuffle
    // when the bridge binds.
    expect(nodeByKey(inv, 'virtio_i2c0:48').presence).toBe('inert')
    expect(nodeByKey(inv, 'virtio_i2c0:48').deviceClass).toBe('sensor')
    const gnss = nodeByKey(inv, 'gnss')
    expect(gnss.presence).toBe('inert')
    expect(gnss.body).toBeUndefined()
  })

  it('keeps stable keys when availability flips from inert to interactive', () => {
    const tree = treeOf(a53Shell, 'shell.dts')
    const cold = deriveDeviceInventory(
      tree,
      A53_SHELL_CHIPS,
      [],
      {
        gnss: false,
        gpio: false,
        audio: false,
        mic: false,
        net: false,
        i2c: false,
        spi: false,
        display: false,
        input: false,
      },
      'qemu_cortex_a53',
    )
    const hot = deriveDeviceInventory(tree, A53_SHELL_CHIPS, [], ALL, 'qemu_cortex_a53')
    expect(cold.nodes.map((n) => n.key).sort()).toEqual(hot.nodes.map((n) => n.key).sort())
    expect(nodeByKey(cold, 'virtio_i2c0').presence).toBe('inert')
    expect(nodeByKey(hot, 'virtio_i2c0').presence).toBe('interactive')
    expect(nodeByKey(cold, 'gnss').presence).toBe('inert')
    expect(nodeByKey(hot, 'gnss').presence).toBe('interactive')
  })

  it('emits a buzzer dock row when gpio-buzzer is on the bridged controller', () => {
    const inv = deriveDeviceInventory(
      treeOf(`
        /dts-v1/;
        / {
          model = "QEMU Cortex-A53";
          soc {
            virtio_gpio0: gpio@a000400 {
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
      `),
      [],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const buzzer = nodeByKey(inv, 'buzzer')
    expect(buzzer.presence).toBe('interactive')
    expect(buzzer.body).toBe('buzzer')
    expect(buzzer.deviceClass).toBe('buzzer')
    expect(buzzer.compatible).toBe('gpio-buzzer')
    expect(buzzer.panelKind).toBe('buzzer')
    expect(buzzer.crumb).toBe('pin 5')
    expect(buzzer.label).toBe('Browser buzzer')
    expect(nodeByKey(inv, 'gpio').presence).toBe('interactive')
  })

  it('emits a seven-seg dock row when gpio-7-segment is on the bridged controller', () => {
    const inv = deriveDeviceInventory(
      treeOf(`
        /dts-v1/;
        / {
          model = "QEMU Cortex-A53";
          soc {
            virtio_gpio0: gpio@a000400 {
              compatible = "virtio,gpio";
              gpio-controller;
              #gpio-cells = <2>;
              ngpios = <16>;
              status = "okay";
            };
          };
          digi_display: digi-display {
            compatible = "gpio-7-segment";
            label = "7-segment LED";
            columns = <3>;
            rows = <1>;
            segment-gpios = <&virtio_gpio0 8 1>,
                            <&virtio_gpio0 9 1>,
                            <&virtio_gpio0 10 1>,
                            <&virtio_gpio0 11 1>,
                            <&virtio_gpio0 12 1>,
                            <&virtio_gpio0 13 1>,
                            <&virtio_gpio0 14 1>,
                            <&virtio_gpio0 15 1>;
            digit-gpios = <&virtio_gpio0 5 0>,
                          <&virtio_gpio0 6 0>,
                          <&virtio_gpio0 7 0>;
            refresh-period-ms = <1>;
          };
        };
      `),
      [],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const row = inv.nodes.find((n) => n.body === 'seven-seg')
    expect(row).toBeTruthy()
    expect(row!.presence).toBe('interactive')
    expect(row!.deviceClass).toBe('auxdisplay')
    expect(row!.compatible).toBe('gpio-7-segment')
    expect(row!.panelKind).toBe('auxdisplay')
    expect(row!.label).toBe('7-segment LED')
    expect(row!.crumb).toBe('3-digit · virtio_gpio0')
  })

  it('emits a stepper dock row when gpio step/dir is on the bridged controller', () => {
    const inv = deriveDeviceInventory(
      treeOf(`
        /dts-v1/;
        / {
          model = "QEMU Cortex-A53";
          soc {
            virtio_gpio0: gpio@a000400 {
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
      `),
      [],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const stepper = nodeByKey(inv, 'stepper')
    expect(stepper.presence).toBe('interactive')
    expect(stepper.body).toBe('stepper')
    expect(stepper.deviceClass).toBe('stepper')
    expect(stepper.compatible).toBe('zephyr,gpio-step-dir-stepper-ctrl')
    expect(stepper.panelKind).toBe('stepper')
    expect(stepper.crumb).toBe('STEP 6 · DIR 7')
    expect(stepper.label).toBe('browser_stepper')
    expect(nodeByKey(inv, 'gpio').presence).toBe('interactive')
  })

  it('emits a gpio-leds dock row in the LED class', () => {
    const inv = deriveDeviceInventory(
      treeOf(a53Blinky),
      [],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const leds = nodeByKey(inv, 'gpio-leds')
    expect(leds.presence).toBe('interactive')
    expect(leds.body).toBe('gpio-leds')
    expect(leds.deviceClass).toBe('led')
    expect(leds.compatible).toBe('gpio-leds')
    expect(leds.panelKind).toBe('led')
    expect(leds.label).toBe('GPIO LEDs')
    expect(nodeByKey(inv, 'gpio').body).toBe('gpio')
  })

  it('emits a gpio-keys dock row in the Keys class', () => {
    const inv = deriveDeviceInventory(
      treeOf(a53Blinky),
      [],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const keys = nodeByKey(inv, 'gpio-keys')
    expect(keys.presence).toBe('interactive')
    expect(keys.body).toBe('gpio-keys')
    expect(keys.deviceClass).toBe('keys')
    expect(keys.compatible).toBe('gpio-keys')
    expect(keys.panelKind).toBe('keys')
    expect(keys.label).toBe('GPIO Keys')
  })

  it('emits a pwm-leds dock row alongside the PCA9685 PWM chip', () => {
    const chip = createPca9685({ address: 0x60 })
    const inv = deriveDeviceInventory(
      treeOf(`
        /dts-v1/;
        / {
          model = "QEMU Cortex-A53";
          soc {
            virtio_mmio@a000800 {
              compatible = "virtio,mmio";
              status = "okay";
              virtio_i2c0: virtio-i2c {
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
      `),
      [chip],
      [],
      ALL,
      'qemu_cortex_a53',
    )
    const leds = nodeByKey(inv, 'pwm-leds')
    expect(leds.presence).toBe('interactive')
    expect(leds.body).toBe('pwm-leds')
    expect(leds.deviceClass).toBe('led')
    expect(leds.compatible).toBe('pwm-leds')
    expect(leds.panelKind).toBe('led')
    expect(leds.chip).toBe(chip)
    expect(leds.pwmLeds).toEqual([
      { channel: 0, label: 'PWM LED 0' },
      { channel: 1, label: 'PWM LED 1' },
    ])
    const pwm = inv.nodes.find((n) => n.body === 'pwm')
    expect(pwm?.presence).toBe('interactive')
    expect(pwm?.panelKind).toBe('pwm')
    expect(pwm?.chip).toBe(chip)
  })
})

describe('deriveDeviceInventory fallback (no devicetree)', () => {
  it('mirrors the A53 overlays', () => {
    const inv = deriveDeviceInventory(null, A53_DEFAULT_CHIPS, [], ALL, 'qemu_cortex_a53')

    expect(inv.source).toBe('fallback')
    expect(inv.nodes.filter((n) => n.parentKey === 'virtio_i2c0').map((n) => n.key)).toEqual([
      'virtio_i2c0:3c',
      'virtio_i2c0:48',
      'virtio_i2c0:49',
      'virtio_i2c0:50',
      'virtio_i2c0:53',
    ])
    expect(nodeByKey(inv, 'virtio_i2c0').presence).toBe('interactive')
    const tmp = nodeByKey(inv, 'virtio_i2c0:48')
    expect(tmp.nodeName).toBe('tmp112@48')
    expect(tmp.compatible).toBe('ti,tmp112')
    expect(nodeByKey(inv, 'net').crumb).toBe('virtio_net0')
    expect(nodeByKey(inv, 'uart0').nodeName).toBe('uart@9000000')
    expect(nodeByKey(inv, 'uart0').deviceClass).toBe('uart-bus')
    expect(nodeByKey(inv, 'display').note).toBe('on stage')
  })

  it('ghosts a detached declared chip exactly like the devicetree path', () => {
    const chips = A53_DEFAULT_CHIPS.filter((chip) => chip.address !== 0x53)
    const inv = deriveDeviceInventory(null, chips, [], ALL, 'qemu_cortex_a53')
    const adxl = nodeByKey(inv, 'virtio_i2c0:53')
    expect(adxl.presence).toBe('ghost')
    expect(adxl.deviceClass).toBe('sensor')
    expect(adxl.label).toBe('ADXL345 accelerometer')
  })

  it('mirrors the M3 board: stellaris names, no bus, no display', () => {
    const inv = deriveDeviceInventory(null, [], [], ALL, 'qemu_cortex_m3')

    expect(nodeByKey(inv, 'net').nodeName).toBe('ethernet@40048000')
    expect(nodeByKey(inv, 'net').crumb).toBe('eth0')
    expect(nodeByKey(inv, 'gpio').nodeName).toBe('gpio@40061000')
    expect(nodeByKey(inv, 'gpio').compatible).toBe('qemu,host-gpio')
    expect(inv.nodes.some((n) => n.deviceClass === 'i2c-bus')).toBe(false)
    expect(inv.nodes.some((n) => n.deviceClass === 'display')).toBe(false)
  })

  it('lists the full A53 fallback as inert before any bridge is up', () => {
    const none: Availability = {
      gnss: false,
      gpio: false,
      audio: false,
      mic: false,
      net: false,
      i2c: false,
      spi: false,
      display: false,
      input: false,
    }
    const inv = deriveDeviceInventory(null, [], [], none, 'qemu_cortex_a53')
    expect(inv.source).toBe('fallback')
    expect(nodeByKey(inv, 'virtio_i2c0').presence).toBe('inert')
    expect(nodeByKey(inv, 'virtio_i2c0:48').presence).toBe('inert')
    expect(nodeByKey(inv, 'virtio_i2c0:48').deviceClass).toBe('sensor')
    expect(nodeByKey(inv, 'gnss').presence).toBe('inert')
    expect(nodeByKey(inv, 'gpio').presence).toBe('inert')
    expect(nodeByKey(inv, 'display').note).toBe('on stage')
    expect(nodeByKey(inv, 'virtio_spi0:0').presence).toBe('inert')
  })
})

describe('buildRowList', () => {
  it('emits identical device keys in both views', () => {
    for (const inv of [
      deriveDeviceInventory(treeOf(a53Shell), A53_SHELL_CHIPS, [], ALL, 'qemu_cortex_a53'),
      deriveDeviceInventory(treeOf(twoBuses), [fakeSensor(0x48, 'TMP112')], [], ALL, 'qemu_cortex_a53'),
      deriveDeviceInventory(null, A53_DEFAULT_CHIPS, [], ALL, 'qemu_cortex_a53'),
    ]) {
      const dt = deviceKeys(buildRowList(inv, 'devicetree'))
      const classes = deviceKeys(buildRowList(inv, 'classes'))
      expect(new Set(dt)).toEqual(new Set(classes))
      expect(dt).toHaveLength(classes.length)
    }
  })

  it('nests the ⌗ view: root, soc scaffold, chips one deeper than their bus', () => {
    const inv = deriveDeviceInventory(treeOf(a53Shell, 'shell.dts'), A53_SHELL_CHIPS, [], ALL, 'qemu_cortex_a53')
    const rows = buildRowList(inv, 'devicetree')

    expect(rows[0]).toMatchObject({ kind: 'struct', key: 'root', name: '/' })
    const soc = rows.find((row) => row.kind === 'struct' && row.key === 'struct:soc')
    expect(soc).toBeDefined()

    const busRow = rows.find((row) => row.kind === 'device' && row.node.key === 'virtio_i2c0')
    const chipRow = rows.find((row) => row.kind === 'device' && row.node.key === 'virtio_i2c0:48')
    expect(busRow!.kind === 'device' && chipRow!.kind === 'device').toBe(true)
    expect((chipRow as Extract<Row, { kind: 'device' }>).depth).toBe(
      (busRow as Extract<Row, { kind: 'device' }>).depth + 1,
    )

    const gnssRow = rows.find((row) => row.kind === 'device' && row.node.key === 'gnss')
    const uartRow = rows.find(
      (row) => row.kind === 'device' && row.node.key === (gnssRow as any).node.parentKey,
    )
    expect((gnssRow as any).depth).toBe((uartRow as any).depth + 1)
  })

  it('groups the ▤ view with friendly labels and counts', () => {
    const inv = deriveDeviceInventory(treeOf(a53Shell), A53_SHELL_CHIPS, [], ALL, 'qemu_cortex_a53')
    const rows = buildRowList(inv, 'classes')

    const sensors = rows.find((row) => row.kind === 'group' && row.deviceClass === 'sensor')
    expect(sensors).toMatchObject({ label: 'Sensors', count: 7 })

    // Group headers precede their members; members carry breadcrumbs.
    const sensorIdx = rows.indexOf(sensors!)
    const tmpIdx = rows.findIndex(
      (row) => row.kind === 'device' && row.node.key === 'virtio_i2c0:48',
    )
    expect(tmpIdx).toBeGreaterThan(sensorIdx)

    // No raw class ids leak into labels (friendly only).
    for (const row of rows) {
      if (row.kind === 'group') expect(row.label).not.toMatch(/^[a-z0-9-]+$/)
    }

    const uarts = rows.find((row) => row.kind === 'group' && row.deviceClass === 'uart-bus')
    expect(uarts).toMatchObject({ label: 'UART buses', count: 2 })
    // GNSS stays its own class; it only nests under the UART in ⌗ view.
    expect(rows.some((row) => row.kind === 'group' && row.deviceClass === 'gnss')).toBe(true)
  })

  it('nests an unbridged bus’s slots under it inside the bus group', () => {
    const inv = deriveDeviceInventory(treeOf(twoBuses), [], [], ALL, 'qemu_cortex_a53')
    const rows = buildRowList(inv, 'classes')
    const bme = rows.find((row) => row.kind === 'device' && row.node.key === 'i2c0:76')
    expect((bme as Extract<Row, { kind: 'device' }>).depth).toBe(1)
  })
})
