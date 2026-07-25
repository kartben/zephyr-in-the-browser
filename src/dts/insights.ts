/**
 * From a parsed devicetree to the concepts this app actually models.
 *
 * This is where "de facto binding adherence" lives: instead of shipping
 * Zephyr's bindings, a small compatible→model table maps the chips and
 * controllers the page simulates. Everything else in the tree is still
 * enumerated — a real board's file dropped by a user lists its buses too —
 * but only the nodes the browser bridges (`bridged`) drive device models.
 *
 * `panels` means *availability*, not emphasis: the shield builds the GNSS,
 * audio and network bridges into nearly every image, so their presence says
 * little. The value is in the negative signal — a build whose tree has no
 * enabled I2C bus should not offer an I2C panel — and in grounding a custom
 * ELF's panel set, which is otherwise unknowable.
 */

import type { PanelKind } from '@/boards'
import type { DtsDocument, DtsNode } from './model'
import {
  boolProp,
  chosen,
  compatibles,
  gpioSpecs,
  isEffectivelyOkay,
  numberProp,
  pathOf,
  prop,
  regAddress,
  stringProp,
} from './query'

export interface I2cSlot {
  address: number
  /** First compatible of the chip node. */
  compatible: string
  /** Matching page-side model (ChipType.id in src/virtio/devices/registry.ts). */
  chipId?: string
  nodeName: string
}

export interface I2cBus {
  /** First label, else the node name — what shell hints quote. */
  controllerLabel: string
  path: string
  compatible: string
  /** Whether this is the bus the page's device models sit on. */
  bridged: boolean
  slots: I2cSlot[]
}

export interface DtsPin {
  id: number
  label: string
}

export interface GpioController {
  controllerLabel: string
  path: string
  compatible: string
  /** Whether this is the controller the browser GPIO panel drives. */
  bridged: boolean
  ngpios?: number
  /** gpio-keys entries wired to this controller. */
  buttons: DtsPin[]
  /** gpio-leds entries wired to this controller. */
  leds: DtsPin[]
}

export interface DtsInsights {
  /** Root `model` string — display-only. */
  model?: string
  /** Label (or path) of the chosen zephyr,console. */
  console?: string
  memory: Array<{ base: number; bytes: number }>
  /** Alias name → node path. */
  aliases: Record<string, string>
  i2cBuses: I2cBus[]
  gpioControllers: GpioController[]
  /** Panels this build can meaningfully use. */
  panels: Set<PanelKind>
}

/**
 * Chips the page can model, by devicetree compatible. Ids match ChipType.id
 * in src/virtio/devices/registry.ts; a compatible outside this table is still
 * listed as a slot, just with no page model to attach.
 */
const COMPAT_TO_CHIP: Record<string, string> = {
  'ti,tmp112': 'tmp112',
  lm75: 'lm75',
  'national,lm75': 'lm75',
  'adi,adxl345': 'adxl345',
  'st,lsm6dso': 'lsm6dso',
  'st,lps22hh': 'lps22hh',
  'ti,ina219': 'ina219',
  'isil,isl29035': 'isl29035',
  'atmel,at24': 'at24',
  'solomon,ssd1306': 'ssd1306',
  'nxp,pcf8523': 'pcf8523',
}

const SENSOR_CHIP_IDS = new Set([
  'tmp112',
  'lm75',
  'adxl345',
  'lsm6dso',
  'lps22hh',
  'ina219',
  'isl29035',
])

/** The I2C adapter the page's chips answer on (QEMU's `name=i2c` device). */
const BRIDGED_I2C_COMPATS = new Set(['virtio,i2c'])
/** The GPIO controllers the browser panel drives, one per board. */
const BRIDGED_GPIO_COMPATS = new Set(['qemu,host-gpio', 'virtio,gpio'])

const effectivelyOkay = isEffectivelyOkay

function labelOf(node: DtsNode): string {
  return node.labels[0] ?? node.name
}

function walk(node: DtsNode, visit: (node: DtsNode) => void) {
  visit(node)
  node.children.forEach((child) => walk(child, visit))
}

/** I2C device addresses; outside 0x03–0x77 is reserved by the protocol. */
function isI2cAddress(address: number): boolean {
  return address >= 0x03 && address <= 0x77
}

function i2cSlots(bus: DtsNode): I2cSlot[] {
  const slots: I2cSlot[] = []
  for (const child of bus.children) {
    if (!effectivelyOkay(child)) continue
    const address = regAddress(child)
    if (address === undefined || !isI2cAddress(address)) continue
    const compatible = compatibles(child)[0] ?? ''
    slots.push({
      address,
      compatible,
      chipId: compatibles(child)
        .map((c) => COMPAT_TO_CHIP[c])
        .find((id) => id !== undefined),
      nodeName: child.name,
    })
  }
  return slots.sort((a, b) => a.address - b.address)
}

/**
 * A node counts as an I2C bus when a known controller compatible says so, or
 * when it merely looks like one — `i2c@...` with addressable children — so
 * trees from boards we have never seen still enumerate sensibly.
 */
function isI2cBus(node: DtsNode): boolean {
  const compats = compatibles(node)
  if (compats.some((c) => BRIDGED_I2C_COMPATS.has(c))) return true
  if (!/^i2c[@-]?/.test(node.name)) return false
  return node.children.some((child) => {
    const address = regAddress(child)
    return address !== undefined && isI2cAddress(address)
  })
}

function collectI2cBuses(doc: DtsDocument): I2cBus[] {
  const buses: I2cBus[] = []
  walk(doc.root, (node) => {
    if (node.name === '/' || !effectivelyOkay(node) || !isI2cBus(node)) return
    buses.push({
      controllerLabel: labelOf(node),
      path: pathOf(node),
      compatible: compatibles(node)[0] ?? '',
      bridged: compatibles(node).some((c) => BRIDGED_I2C_COMPATS.has(c)),
      slots: i2cSlots(node),
    })
  })
  return buses
}

function collectGpioControllers(doc: DtsDocument): GpioController[] {
  const controllers: Array<GpioController & { node: DtsNode }> = []
  walk(doc.root, (node) => {
    if (!boolProp(node, 'gpio-controller') || !effectivelyOkay(node)) return
    controllers.push({
      node,
      controllerLabel: labelOf(node),
      path: pathOf(node),
      compatible: compatibles(node)[0] ?? '',
      bridged: compatibles(node).some((c) => BRIDGED_GPIO_COMPATS.has(c)),
      ngpios: numberProp(node, 'ngpios'),
      buttons: [],
      leds: [],
    })
  })

  // Wire gpio-keys/gpio-leds children to the controller each spec points at.
  // A single leds node can span controllers, so this is per-spec, not per-node.
  const wire = (compat: string, into: 'buttons' | 'leds') => {
    for (const group of doc.compatIndex.get(compat) ?? []) {
      if (!effectivelyOkay(group)) continue
      for (const child of group.children) {
        for (const spec of gpioSpecs(doc, child)) {
          const controller = controllers.find((c) => c.node === spec.controller)
          if (!controller) continue
          controller[into].push({
            id: spec.pin,
            label: stringProp(child, 'label') ?? labelOf(child),
          })
        }
      }
    }
  }
  wire('gpio-keys', 'buttons')
  wire('gpio-leds', 'leds')

  for (const controller of controllers) {
    controller.buttons.sort((a, b) => a.id - b.id)
    controller.leds.sort((a, b) => a.id - b.id)
  }
  return controllers.map(({ node: _node, ...controller }) => controller)
}

function collectMemory(doc: DtsDocument): Array<{ base: number; bytes: number }> {
  const regions: Array<{ base: number; bytes: number }> = []
  walk(doc.root, (node) => {
    if (stringProp(node, 'device_type') !== 'memory' || !effectivelyOkay(node)) return
    const cells = (prop(node, 'reg')?.values ?? []).flatMap((v) =>
      v.kind === 'cells' ? v.cells.flatMap((c) => (c.kind === 'number' ? [c.value] : [])) : [],
    )
    // Cell widths come from the parent; 2+2 on 64-bit trees, 1+1 on 32-bit.
    const parent = node.parent ?? doc.root
    const ac = numberProp(parent, '#address-cells') ?? 2
    const sc = numberProp(parent, '#size-cells') ?? 1
    const join = (parts: number[]) => parts.reduce((acc, part) => acc * 0x100000000 + part, 0)
    if (cells.length >= ac + sc) {
      regions.push({ base: join(cells.slice(0, ac)), bytes: join(cells.slice(ac, ac + sc)) })
    }
  })
  return regions
}

function hasOkayCompat(doc: DtsDocument, compat: string): boolean {
  return (doc.compatIndex.get(compat) ?? []).some(effectivelyOkay)
}

/**
 * The panels worth *expanding* for a build known only by its devicetree (a
 * custom ELF with a dropped zephyr.dts): availability minus the bridges the
 * shield wires into nearly every image, whose presence says nothing about
 * what the program is about.
 */
export function emphasisPanels(insights: DtsInsights): Set<PanelKind> {
  const ubiquitous = new Set<PanelKind>(['gnss', 'audio', 'net'])
  return new Set([...insights.panels].filter((kind) => !ubiquitous.has(kind)))
}

export function computeInsights(doc: DtsDocument): DtsInsights {
  const i2cBuses = collectI2cBuses(doc)
  const gpioControllers = collectGpioControllers(doc)
  const chosenTable = chosen(doc)

  const bridgedBuses = i2cBuses.filter((bus) => bus.bridged)
  const bridgedSlots = bridgedBuses.flatMap((bus) => bus.slots)

  const panels = new Set<PanelKind>()
  if (hasOkayCompat(doc, 'gnss-nmea-generic')) panels.add('gnss')
  if (hasOkayCompat(doc, 'qemu,ramfb') || hasOkayCompat(doc, 'virtio,gpu')) panels.add('display')
  if (hasOkayCompat(doc, 'qemu,host-audio') || hasOkayCompat(doc, 'qemu,host-mic')) {
    panels.add('audio')
  }
  if (hasOkayCompat(doc, 'virtio,net') || hasOkayCompat(doc, 'ti,stellaris-ethernet')) {
    panels.add('net')
  }
  if (bridgedBuses.length > 0) panels.add('i2c')
  if (bridgedSlots.some((slot) => slot.chipId !== undefined && SENSOR_CHIP_IDS.has(slot.chipId))) {
    panels.add('sensor')
  }
  if (gpioControllers.some((controller) => controller.bridged)) panels.add('gpio')
  const display = chosenTable['zephyr,display']
  if (display && compatibles(display).includes('solomon,ssd1306')) panels.add('oled')
  // 'perf' is a machine property (-icount), invisible to the guest tree.

  const aliasTable: Record<string, string> = {}
  const aliasNode = doc.root.children.find((c) => c.name === 'aliases')
  for (const property of aliasNode?.properties ?? []) {
    for (const value of property.values) {
      if (value.kind === 'ref') {
        const target = doc.labelIndex.get(value.label)
        if (target) aliasTable[property.name] = pathOf(target)
      } else if (value.kind === 'string') {
        aliasTable[property.name] = value.value
      }
    }
  }

  const consoleNode = chosenTable['zephyr,console']

  return {
    model: stringProp(doc.root, 'model'),
    console: consoleNode ? labelOf(consoleNode) : undefined,
    memory: collectMemory(doc),
    aliases: aliasTable,
    i2cBuses,
    gpioControllers,
    panels,
  }
}
