import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import a53Shell from '@/dts/fixtures/qemu_cortex_a53_shell.dts?raw'
import type { PanelKind } from '@/boards'
import type { Availability, DeviceNode, Row } from '@/deviceTopology'
import { CLASS_LABELS, buildRowList, deriveDeviceInventory } from '@/deviceTopology'
import { isLeadNode, sampleFirst, type InstrumentSlot, type SampleFirst } from './dockSections'

function node(partial: Pick<DeviceNode, 'key'> & Partial<DeviceNode>): DeviceNode {
  return {
    nodeName: partial.key,
    label: partial.key,
    deviceClass: 'other',
    path: `/${partial.key}`,
    presence: 'interactive',
    ...partial,
  }
}

const device = (n: DeviceNode, depth = 0): Row => ({ kind: 'device', node: n, depth })
const group = (deviceClass: DeviceNode['deviceClass'], count: number): Row => ({
  kind: 'group',
  key: `group:${deviceClass}`,
  deviceClass,
  label: CLASS_LABELS[deviceClass],
  count,
})

/** The Cortex-M3 Button sample's ▤ rows, in class order, as the dock built them. */
const uart0 = node({ key: 'uart0', deviceClass: 'uart-bus', presence: 'inert' })
const leds = node({ key: 'gpio-leds', deviceClass: 'led', panelKind: 'led' })
const gpio0 = node({ key: 'gpio:gpio0', deviceClass: 'gpio', presence: 'inert', note: 'no page model' })
const gpio = node({ key: 'gpio', deviceClass: 'gpio', panelKind: 'gpio' })
const keys = node({ key: 'gpio-keys', deviceClass: 'keys', panelKind: 'keys' })
const bt = node({ key: 'bluetooth', deviceClass: 'bluetooth', presence: 'inert' })
const BUTTON_ROWS: Row[] = [
  group('led', 1),
  device(leds),
  group('uart-bus', 1),
  device(uart0),
  group('gpio', 2),
  device(gpio0),
  device(gpio),
  group('keys', 1),
  device(keys),
  group('bluetooth', 1),
  device(bt),
]

const INSTRUMENTS: InstrumentSlot[] = [
  { key: 'stage:perf', panelKind: 'perf' },
  { key: 'stage:trace', panelKind: 'trace' },
  { key: 'stage:debug', panelKind: 'debug' },
]

/** Lead rows as keys, devices and instruments alike. */
const leadKeys = (layout: SampleFirst) =>
  layout.lead.map((row) => (row.kind === 'device' ? row.node.key : row.key))
const rowKeys = (rows: readonly Row[]) =>
  rows.map((row) => (row.kind === 'device' ? row.node.key : row.key))

describe('sampleFirst', () => {
  it('leads with the sample’s rows in its primaryPanels order, not class order', () => {
    const layout = sampleFirst(BUTTON_ROWS, ['keys', 'led', 'gpio'], INSTRUMENTS.slice(2))
    // Keys before LEDs, as basic_button lists them; LEDs come first by class.
    expect(leadKeys(layout)).toEqual(['gpio-keys', 'gpio-leds', 'gpio'])
    expect(layout.instruments).toEqual(['stage:debug'])
  })

  it('folds everything else, recounting the groups and dropping emptied ones', () => {
    const layout = sampleFirst(BUTTON_ROWS, ['keys', 'led', 'gpio'], [])
    expect(rowKeys(layout.more)).toEqual([
      'group:uart-bus',
      'uart0',
      'group:gpio',
      'gpio:gpio0',
      'group:bluetooth',
      'bluetooth',
    ])
    // The GPIO group lost its bridged controller to the top: one left.
    expect(layout.more.find((row) => row.kind === 'group' && row.deviceClass === 'gpio')).toMatchObject({
      count: 1,
    })
    expect(layout.moreCount).toBe(3)
  })

  it('puts an instrument the sample names in its place among the sample’s rows', () => {
    // A traced twin appends trace and debug (withA53TraceVariants).
    const layout = sampleFirst(BUTTON_ROWS, ['keys', 'trace', 'led', 'debug'], INSTRUMENTS)
    expect(leadKeys(layout)).toEqual(['gpio-keys', 'stage:trace', 'gpio-leds', 'stage:debug'])
    expect(layout.instruments).toEqual(['stage:perf'])
  })

  it('names an instrument only when it is on screen', () => {
    // tracing names trace; a guest without the Trace row has nothing to place.
    const layout = sampleFirst(BUTTON_ROWS, ['trace'], INSTRUMENTS.slice(2))
    expect(layout.lead).toEqual([])
    expect(layout.instruments).toEqual(['stage:debug'])
  })

  it('puts a device before the instrument of the same kind', () => {
    // The ESP32-C3 sleep samples list perf: the power card and Simulation.
    const power = node({ key: 'rtc_cntl', deviceClass: 'power', panelKind: 'perf' })
    const layout = sampleFirst([group('power', 1), device(power)], ['perf'], INSTRUMENTS)
    expect(leadKeys(layout)).toEqual(['rtc_cntl', 'stage:perf'])
    expect(layout.more).toEqual([])
    expect(layout.moreCount).toBe(0)
  })

  it('leads a kind with its bus, then the parts on it', () => {
    const bus = node({ key: 'i2c0', deviceClass: 'i2c-bus', panelKind: 'i2c' })
    const eeprom = node({ key: 'i2c0:50', deviceClass: 'memory', panelKind: 'i2c', parentKey: 'i2c0' })
    const rows = [group('memory', 1), device(eeprom), group('i2c-bus', 1), device(bus)]
    expect(leadKeys(sampleFirst(rows, ['i2c'], []))).toEqual(['i2c0', 'i2c0:50'])
  })

  it('flattens a lead row and un-nests what was nested under it', () => {
    const bus = node({ key: 'i2c0', deviceClass: 'i2c-bus', panelKind: 'i2c' })
    const ghost = node({ key: 'i2c0:76', deviceClass: 'i2c-bus', parentKey: 'i2c0', presence: 'ghost' })
    const layout = sampleFirst([group('i2c-bus', 2), device(bus), device(ghost, 1)], ['i2c'], [])
    expect(layout.lead).toEqual([{ kind: 'device', node: bus, depth: 0 }])
    expect(layout.more).toEqual([group('i2c-bus', 1), device(ghost, 0)])
  })

  it('works on classes listed without a group header', () => {
    // A one-device class may come without its header: it stands on its own.
    const rows: Row[] = [device(leds), group('gpio', 2), device(gpio0), device(gpio), device(keys), device(bt)]
    const layout = sampleFirst(rows, ['keys'], [])
    expect(leadKeys(layout)).toEqual(['gpio-keys'])
    expect(rowKeys(layout.more)).toEqual(['gpio-leds', 'group:gpio', 'gpio:gpio0', 'gpio', 'bluetooth'])
    expect(layout.moreCount).toBe(4)
  })

  it('with nothing named, leads with nothing and folds every device', () => {
    const layout = sampleFirst(BUTTON_ROWS, [], INSTRUMENTS)
    expect(layout.lead).toEqual([])
    expect(layout.instruments).toEqual(['stage:perf', 'stage:trace', 'stage:debug'])
    expect(rowKeys(layout.more)).toEqual(rowKeys(BUTTON_ROWS))
    expect(layout.moreCount).toBe(6)
  })

  it('keeps every device of a real inventory exactly once', () => {
    const doc = parseDts(a53Shell)
    const all: Availability = {
      gnss: true,
      bluetooth: true,
      gpio: true,
      audio: true,
      mic: true,
      net: true,
      i2c: true,
      spi: true,
      can: false,
      power: false,
      watchdog: false,
      display: true,
      input: true,
      disk: false,
    }
    const inv = deriveDeviceInventory(
      { name: 'shell.dts', doc, insights: computeInsights(doc) },
      [],
      [],
      all,
      'qemu_cortex_a53',
    )
    const rows = buildRowList(inv, 'classes')
    const primary: PanelKind[] = ['i2c', 'spi', 'auxdisplay', 'gpio', 'audio']
    const layout = sampleFirst(rows, primary, [])

    const leadDevices = layout.lead.flatMap((row) => (row.kind === 'device' ? [row.node.key] : []))
    const moreDevices = layout.more.flatMap((row) => (row.kind === 'device' ? [row.node.key] : []))
    expect(leadDevices.length).toBeGreaterThan(0)
    expect([...leadDevices, ...moreDevices].sort()).toEqual(inv.nodes.map((n) => n.key).sort())
    expect(layout.moreCount).toBe(moreDevices.length)
    // The lead is exactly the rows of the kinds the shell lists.
    for (const key of leadDevices) {
      expect(isLeadNode(inv.nodes.find((n) => n.key === key)!, primary)).toBe(true)
    }
    for (const key of moreDevices) {
      expect(isLeadNode(inv.nodes.find((n) => n.key === key)!, primary)).toBe(false)
    }
    // Every group left in the fold counts the devices that follow it.
    layout.more.forEach((row, i) => {
      if (row.kind !== 'group') return
      let members = 0
      for (let j = i + 1; j < layout.more.length && layout.more[j].kind === 'device'; j++) members++
      expect(row.count).toBe(members)
    })
  })
})
