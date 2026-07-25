import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import type { I2cChip } from '@/virtio/devices/i2c'
import a53Shell from '@/dts/fixtures/qemu_cortex_a53_shell.dts?raw'
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
  display: true,
  input: true,
}

/* Fakes carrying just the duck-type markers the classifiers look for. */
const fakeSensor = (address: number, name: string): I2cChip =>
  ({ address, name, decl: {}, setChannel() {} }) as unknown as I2cChip
const fakeMemory = (address: number, name: string): I2cChip =>
  ({ address, name, decl: {}, poke() {}, erase() {}, version: () => 0 }) as unknown as I2cChip
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

/** Shell with i2c-sensors-extra: defaults plus the optional parts. */
const A53_SHELL_CHIPS: I2cChip[] = [
  ...A53_DEFAULT_CHIPS,
  fakeSensor(0x40, 'INA219 power monitor'),
  fakeSensor(0x44, 'ISL29035 light'),
  fakeSensor(0x5c, 'LPS22HH pressure'),
  fakeRtc(0x68, 'PCF8523 RTC'),
  fakeSensor(0x6a, 'LSM6DSO IMU'),
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
    const inv = deriveDeviceInventory(treeOf(a53Shell, 'shell.dts'), A53_SHELL_CHIPS, ALL, 'qemu_cortex_a53')

    expect(inv.source).toBe('devicetree')
    expect(inv.rootName).toBe('QEMU Cortex-A53')

    const bus = nodeByKey(inv, 'virtio_i2c0')
    expect(bus.presence).toBe('interactive')
    expect(bus.body).toBe('i2c')
    expect(bus.nodeName).toBe('virtio-i2c')

    // All ten chips, in address order, named by their devicetree nodes.
    const chipRows = inv.nodes.filter((n) => n.parentKey === 'virtio_i2c0')
    expect(chipRows.map((n) => n.key)).toEqual([
      'virtio_i2c0:3c',
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
    expect(nodeByKey(inv, 'virtio_i2c0:68').deviceClass).toBe('rtc')
    expect(nodeByKey(inv, 'virtio_i2c0:68').body).toBe('rtc')

    // The ⌗ story: the GNSS receiver hangs off uart1, not off thin air.
    const gnss = nodeByKey(inv, 'gnss')
    const uart = inv.nodes.find((n) => n.key === gnss.parentKey)
    expect(uart?.nodeName).toBe('uart@9040000')
    expect(uart?.deviceClass).toBe('serial')

    expect(nodeByKey(inv, 'serial:console').note).toBe('→ terminal')
    expect(nodeByKey(inv, 'display').note).toBe('on stage')
    expect(nodeByKey(inv, 'display').nodeName).toBe('ramfb')
    expect(nodeByKey(inv, 'net').nodeName).toBe('virtio-net')

    // virtio_gpio0 is disabled in this build: no controller, no row.
    expect(inv.nodes.some((n) => n.deviceClass === 'gpio')).toBe(false)
  })

  it('shows declared-but-unanswered slots as ghosts', () => {
    const inv = deriveDeviceInventory(treeOf(a53Shell), [], ALL, 'qemu_cortex_a53')

    const ghosts = inv.nodes.filter((n) => n.presence === 'ghost')
    expect(ghosts).toHaveLength(10)
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

  it('hides bridged surfaces the runtime has not exposed', () => {
    const inv = deriveDeviceInventory(
      treeOf(a53Shell),
      A53_SHELL_CHIPS,
      { ...ALL, i2c: false, gnss: false },
      'qemu_cortex_a53',
    )
    expect(inv.nodes.some((n) => n.deviceClass === 'i2c-bus')).toBe(false)
    expect(inv.nodes.some((n) => n.key === 'gnss')).toBe(false)
  })
})

describe('deriveDeviceInventory fallback (no devicetree)', () => {
  it('mirrors the A53 overlays', () => {
    const inv = deriveDeviceInventory(null, A53_DEFAULT_CHIPS, ALL, 'qemu_cortex_a53')

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
    expect(nodeByKey(inv, 'serial:console').nodeName).toBe('uart@9000000')
    expect(nodeByKey(inv, 'display').note).toBe('on stage')
  })

  it('ghosts a detached declared chip exactly like the devicetree path', () => {
    const chips = A53_DEFAULT_CHIPS.filter((chip) => chip.address !== 0x53)
    const inv = deriveDeviceInventory(null, chips, ALL, 'qemu_cortex_a53')
    const adxl = nodeByKey(inv, 'virtio_i2c0:53')
    expect(adxl.presence).toBe('ghost')
    expect(adxl.deviceClass).toBe('sensor')
    expect(adxl.label).toBe('ADXL345 accelerometer')
  })

  it('mirrors the M3 board: stellaris names, no bus, no display', () => {
    const avail: Availability = {
      ...ALL,
      i2c: false,
      display: false,
      input: false,
    }
    const inv = deriveDeviceInventory(null, [], avail, 'qemu_cortex_m3')

    expect(nodeByKey(inv, 'net').nodeName).toBe('ethernet@40048000')
    expect(nodeByKey(inv, 'net').crumb).toBe('eth0')
    expect(nodeByKey(inv, 'gpio').nodeName).toBe('gpio@40061000')
    expect(nodeByKey(inv, 'gpio').compatible).toBe('qemu,host-gpio')
    expect(inv.nodes.some((n) => n.deviceClass === 'i2c-bus')).toBe(false)
    expect(inv.nodes.some((n) => n.deviceClass === 'display')).toBe(false)
  })
})

describe('buildRowList', () => {
  it('emits identical device keys in both views', () => {
    for (const inv of [
      deriveDeviceInventory(treeOf(a53Shell), A53_SHELL_CHIPS, ALL, 'qemu_cortex_a53'),
      deriveDeviceInventory(treeOf(twoBuses), [fakeSensor(0x48, 'TMP112')], ALL, 'qemu_cortex_a53'),
      deriveDeviceInventory(null, A53_DEFAULT_CHIPS, ALL, 'qemu_cortex_a53'),
    ]) {
      const dt = deviceKeys(buildRowList(inv, 'devicetree'))
      const classes = deviceKeys(buildRowList(inv, 'classes'))
      expect(new Set(dt)).toEqual(new Set(classes))
      expect(dt).toHaveLength(classes.length)
    }
  })

  it('nests the ⌗ view: root, soc scaffold, chips one deeper than their bus', () => {
    const inv = deriveDeviceInventory(treeOf(a53Shell, 'shell.dts'), A53_SHELL_CHIPS, ALL, 'qemu_cortex_a53')
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
    const inv = deriveDeviceInventory(treeOf(a53Shell), A53_SHELL_CHIPS, ALL, 'qemu_cortex_a53')
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
  })

  it('nests an unbridged bus’s slots under it inside the bus group', () => {
    const inv = deriveDeviceInventory(treeOf(twoBuses), [], ALL, 'qemu_cortex_a53')
    const rows = buildRowList(inv, 'classes')
    const bme = rows.find((row) => row.kind === 'device' && row.node.key === 'i2c0:76')
    expect((bme as Extract<Row, { kind: 'device' }>).depth).toBe(1)
  })
})
