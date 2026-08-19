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
  pwmSpecs,
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

export interface SpiSlot {
  /** Chip-select index (`reg`). */
  cs: number
  compatible: string
  chipId?: string
  nodeName: string
}

export interface SpiBus {
  controllerLabel: string
  path: string
  compatible: string
  bridged: boolean
  slots: SpiSlot[]
}

export interface UartSlot {
  compatible: string
  /** Matching page-side model id when known (`gnss` for gnss-nmea-generic). */
  chipId?: string
  nodeName: string
}

/**
 * A UART is a bus the same way I²C/SPI are: a controller with optional
 * children hanging off it (NMEA GNSS, …). `role` is how the page uses it —
 * console → terminal, gnss → browser-fed NMEA — not a virtio bridge flag.
 */
export interface UartBus {
  controllerLabel: string
  path: string
  compatible: string
  role?: 'console' | 'gnss' | 'bluetooth'
  slots: UartSlot[]
}

export interface DtsPin {
  id: number
  label: string
  /** Zephyr DT `gpios` flags cell (ACTIVE_LOW, PULL_*, …). */
  flags: number
}

/** A gpio-buzzer wired to a controller output. */
export interface BuzzerPin {
  id: number
  label: string
  /** True when GPIO_ACTIVE_HIGH (Zephyr flag bit0 clear). */
  activeHigh: boolean
}

/**
 * A `zephyr,gpio-step-dir-stepper-ctrl` whose STEP pin is on this controller.
 * DIR may share the controller (typical) or ride another — both pin indices
 * are recorded either way.
 */
export interface StepperAxis {
  /** Stable id: node path. */
  id: string
  label: string
  stepPin: number
  stepActiveHigh: boolean
  dirPin: number
  dirActiveHigh: boolean
  /** DT `invert-direction` boolean. */
  invertDirection: boolean
}

/** One GPIO line of a `gpio-7-segment` (segment or digit select). */
export interface SevenSegPin {
  id: number
  /** True when GPIO_ACTIVE_HIGH (Zephyr flag bit0 clear). */
  activeHigh: boolean
}

/**
 * A `gpio-7-segment` auxdisplay on a bridged GPIO controller.
 * Segments are A…G[,DP]; digits are the multiplex commons.
 */
export interface SevenSegDisplay {
  /** Stable id: node path. */
  id: string
  label: string
  columns: number
  rows: number
  refreshPeriodMs: number
  /** A, B, C, D, E, F, G[, DP] in order. */
  segments: SevenSegPin[]
  /** Digit commons, left → right. */
  digits: SevenSegPin[]
}

/** One child of a `pwm-leds` group, wired to a PWM channel. */
export interface PwmLed {
  /** Channel index on the PWM controller. */
  channel: number
  label: string
  /** Period from the `pwms` specifier, nanoseconds (0 when the controller omits it). */
  periodNs: number
  /** Zephyr PWM_POLARITY_INVERTED = BIT(0). */
  inverted: boolean
  /** PWM controller node path (for matching an attached chip). */
  controllerPath: string
  /** Controller label as written (`pca9685_0`), for crumbs. */
  controllerLabel: string
  /** Path of the parent `pwm-leds` group. */
  groupPath: string
  /** Node name of the parent group (`pwmleds`). */
  groupName: string
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
  /** gpio-buzzer nodes wired to this controller. */
  buzzers: BuzzerPin[]
  /** gpio step/dir stepper controllers whose STEP pin is on this controller. */
  steppers: StepperAxis[]
  /** gpio-7-segment auxdisplays whose digit selects are on this controller. */
  sevenSegs: SevenSegDisplay[]
}

/** A CAN controller the guest drives directly, rather than a chip on a bus. */
export interface CanController {
  nodeName: string
  controllerLabel: string
  path: string
  compatible: string
  /** Whether the page is the other end of this controller's bus. */
  bridged: boolean
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
  spiBuses: SpiBus[]
  uartBuses: UartBus[]
  gpioControllers: GpioController[]
  /** Standalone CAN controllers (not a chip on a bus). */
  canControllers: CanController[]
  /** Children of okay `pwm-leds` groups that resolve a PWM controller. */
  pwmLeds: PwmLed[]
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
  'jhd,jhd1313': 'jhd1313',
  'holtek,ht16k33': 'ht16k33',
  'ti,lp5562': 'lp5562',
  'ti,lp5012': 'lp5012',
  'nxp,pca9685-pwm': 'pca9685',
  'microchip,mcp4725': 'mcp4725',
  'maxim,max17048': 'max17048',
  'nxp,pcf8523': 'pcf8523',
}

const COMPAT_TO_SPI_CHIP: Record<string, string> = {
  'jedec,spi-nor': 'w25q',
  'sct,sct2024': 'sct2024',
  'worldsemi,ws2812-spi': 'ws2812',
  'ptc,pt6314': 'pt6314',
  'adi,tmc50xx': 'tmc50xx',
  'microchip,mcp2515': 'mcp2515',
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
// espressif,esp32-i2c is the odd one out, for the same reason
// espressif,esp32-gpio is below: not a browser-invented device but the SoC's
// own controller, modelled in QEMU and driven by the stock Zephyr driver. The
// page answers for the chips on it through hw/i2c/host_i2c.c, so the bus
// carries page-side models exactly as the virtio one does.
const BRIDGED_I2C_COMPATS = new Set(['virtio,i2c', 'espressif,esp32-i2c'])
/**
 * The SPI controllers the page's chips answer on: QEMU's `name=spi` virtio
 * device, and — like the I2C and GPIO entries above — the ESP32-C3's own
 * GP-SPI2, whose CS0 peripheral is the browser bridge (hw/ssi/host_spi.c).
 */
const BRIDGED_SPI_COMPATS = new Set(['virtio,spi', 'espressif,esp32-spi'])

/**
 * CAN controllers the page's bus model answers for. Only one so far, and it is
 * the odd one out even here: I2C and SPI reach page-side models of *parts*
 * wired next to the SoC, while this is the SoC's own peripheral and what the
 * browser supplies is the wire (net/can/can_browser.c, src/hostTwai.ts). The
 * virtio boards get to CAN through an MCP2515 on SPI instead, which is a chip
 * on a bus and so needs nothing here.
 */
const BRIDGED_CAN_COMPATS = new Set(['espressif,esp32-twai'])
/** The GPIO controllers the browser panel drives, one per board. */
// espressif,esp32-gpio is the odd one out: not a browser-invented device but
// the SoC's own controller, modelled in QEMU and driven by the stock Zephyr
// driver. The page still reaches its pins through the same two exported
// functions as qemu,host-gpio, so it bridges the same way.
const BRIDGED_GPIO_COMPATS = new Set(['qemu,host-gpio', 'virtio,gpio', 'espressif,esp32-gpio'])

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

function spiSlots(bus: DtsNode): SpiSlot[] {
  const slots: SpiSlot[] = []
  for (const child of bus.children) {
    if (!effectivelyOkay(child)) continue
    const cs = regAddress(child)
    if (cs === undefined || cs < 0 || cs > 255) continue
    const compatible = compatibles(child)[0] ?? ''
    slots.push({
      cs,
      compatible,
      chipId: compatibles(child)
        .map((c) => COMPAT_TO_SPI_CHIP[c])
        .find((id) => id !== undefined),
      nodeName: child.name,
    })
  }
  return slots.sort((a, b) => a.cs - b.cs)
}

function isSpiBus(node: DtsNode): boolean {
  const compats = compatibles(node)
  if (compats.some((c) => BRIDGED_SPI_COMPATS.has(c))) return true
  if (!/^spi[@-]?/.test(node.name) && !/^virtio-spi/.test(node.name)) return false
  return node.children.some((child) => {
    const cs = regAddress(child)
    return cs !== undefined && cs >= 0 && cs <= 255
  })
}

function collectSpiBuses(doc: DtsDocument): SpiBus[] {
  const buses: SpiBus[] = []
  walk(doc.root, (node) => {
    if (node.name === '/' || !effectivelyOkay(node) || !isSpiBus(node)) return
    buses.push({
      controllerLabel: labelOf(node),
      path: pathOf(node),
      compatible: compatibles(node)[0] ?? '',
      bridged: compatibles(node).some((c) => BRIDGED_SPI_COMPATS.has(c)),
      slots: spiSlots(node),
    })
  })
  return buses
}

/** Controllers the page recognises as UART (plus name-shaped fallbacks). */
const UART_COMPATS = new Set([
  'arm,pl011',
  'ns16550',
  'ti,stellaris-uart',
])

const UART_SLOT_CHIP: Record<string, string> = {
  'gnss-nmea-generic': 'gnss',
  'zephyr,bt-hci-uart': 'bluetooth',
}

function uartSlots(bus: DtsNode): UartSlot[] {
  const slots: UartSlot[] = []
  for (const child of bus.children) {
    if (!effectivelyOkay(child)) continue
    const compatible = compatibles(child)[0] ?? ''
    // Skip pure property-holder scaffolding; real children carry a compatible.
    if (!compatible) continue
    slots.push({
      compatible,
      chipId: compatibles(child)
        .map((c) => UART_SLOT_CHIP[c])
        .find((id) => id !== undefined),
      nodeName: child.name,
    })
  }
  return slots
}

function isUartBus(node: DtsNode): boolean {
  const compats = compatibles(node)
  if (compats.some((c) => UART_COMPATS.has(c))) return true
  return /^uart[@-]?/.test(node.name) && compats.length > 0
}

function collectUartBuses(doc: DtsDocument): UartBus[] {
  const consoleNode = chosen(doc)['zephyr,console']
  const buses: UartBus[] = []
  walk(doc.root, (node) => {
    if (node.name === '/' || !effectivelyOkay(node) || !isUartBus(node)) return
    const slots = uartSlots(node)
    let role: UartBus['role']
    if (consoleNode === node) role = 'console'
    else if (slots.some((s) => s.chipId === 'gnss')) role = 'gnss'
    else if (slots.some((s) => s.chipId === 'bluetooth')) role = 'bluetooth'
    buses.push({
      controllerLabel: labelOf(node),
      path: pathOf(node),
      compatible: compatibles(node)[0] ?? '',
      role,
      slots,
    })
  })
  return buses
}

function collectCanControllers(doc: DtsDocument): CanController[] {
  const controllers: CanController[] = []
  walk(doc.root, (node) => {
    if (node.name === '/' || !effectivelyOkay(node)) return
    const compats = compatibles(node)
    const bridged = compats.some((c) => BRIDGED_CAN_COMPATS.has(c))
    if (!bridged) return
    controllers.push({
      nodeName: node.name,
      controllerLabel: labelOf(node),
      path: pathOf(node),
      compatible: compats[0] ?? '',
      bridged,
    })
  })
  return controllers
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
      buzzers: [],
      steppers: [],
      sevenSegs: [],
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
            flags: spec.flags,
          })
        }
      }
    }
  }
  wire('gpio-keys', 'buttons')
  wire('gpio-leds', 'leds')

  // gpio-buzzer is a leaf node with its own gpios= property (not a group of children).
  for (const node of doc.compatIndex.get('gpio-buzzer') ?? []) {
    if (!effectivelyOkay(node)) continue
    for (const spec of gpioSpecs(doc, node)) {
      const controller = controllers.find((c) => c.node === spec.controller)
      if (!controller) continue
      // Zephyr GPIO_ACTIVE_LOW = BIT(0).
      controller.buzzers.push({
        id: spec.pin,
        label: stringProp(node, 'label') ?? labelOf(node),
        activeHigh: (spec.flags & 0x1) === 0,
      })
    }
  }

  // zephyr,gpio-step-dir-stepper-ctrl: STEP + DIR named phandle-arrays.
  // Attach to the controller that owns the STEP pin (DIR usually shares it).
  for (const node of doc.compatIndex.get('zephyr,gpio-step-dir-stepper-ctrl') ?? []) {
    if (!effectivelyOkay(node)) continue
    const stepSpec = gpioSpecs(doc, node, 'step-gpios')[0]
    const dirSpec = gpioSpecs(doc, node, 'dir-gpios')[0]
    if (!stepSpec || !dirSpec) continue
    const controller = controllers.find((c) => c.node === stepSpec.controller)
    if (!controller) continue
    controller.steppers.push({
      id: pathOf(node),
      label: stringProp(node, 'label') ?? labelOf(node),
      stepPin: stepSpec.pin,
      stepActiveHigh: (stepSpec.flags & 0x1) === 0,
      dirPin: dirSpec.pin,
      dirActiveHigh: (dirSpec.flags & 0x1) === 0,
      invertDirection: boolProp(node, 'invert-direction'),
    })
  }

  // gpio-7-segment: multiplexed digit commons + shared segment bus.
  for (const node of doc.compatIndex.get('gpio-7-segment') ?? []) {
    if (!effectivelyOkay(node)) continue
    const digitSpecs = gpioSpecs(doc, node, 'digit-gpios')
    const segmentSpecs = gpioSpecs(doc, node, 'segment-gpios')
    if (digitSpecs.length === 0 || segmentSpecs.length < 7) continue
    const controller = controllers.find((c) => c.node === digitSpecs[0]!.controller)
    if (!controller) continue
    const toPin = (spec: (typeof digitSpecs)[number]): SevenSegPin => ({
      id: spec.pin,
      activeHigh: (spec.flags & 0x1) === 0,
    })
    controller.sevenSegs.push({
      id: pathOf(node),
      label: stringProp(node, 'label') ?? '7-segment LED',
      columns: numberProp(node, 'columns') ?? digitSpecs.length,
      rows: numberProp(node, 'rows') ?? 1,
      refreshPeriodMs: numberProp(node, 'refresh-period-ms') ?? 1,
      segments: segmentSpecs.map(toPin),
      digits: digitSpecs.map(toPin),
    })
  }

  for (const controller of controllers) {
    controller.buttons.sort((a, b) => a.id - b.id)
    controller.leds.sort((a, b) => a.id - b.id)
    controller.buzzers.sort((a, b) => a.id - b.id)
    controller.steppers.sort((a, b) => a.stepPin - b.stepPin || a.dirPin - b.dirPin)
    controller.sevenSegs.sort((a, b) => a.id.localeCompare(b.id))
  }
  return controllers.map(({ node: _node, ...controller }) => controller)
}

function collectPwmLeds(doc: DtsDocument): PwmLed[] {
  const leds: PwmLed[] = []
  for (const group of doc.compatIndex.get('pwm-leds') ?? []) {
    if (!effectivelyOkay(group)) continue
    const groupPath = pathOf(group)
    for (const child of group.children) {
      if (!effectivelyOkay(child)) continue
      for (const spec of pwmSpecs(doc, child)) {
        if (!spec.controller) continue
        leds.push({
          channel: spec.channel,
          label: stringProp(child, 'label') ?? labelOf(child),
          periodNs: spec.periodNs,
          // Zephyr PWM_POLARITY_INVERTED = BIT(0).
          inverted: (spec.flags & 0x1) !== 0,
          controllerPath: pathOf(spec.controller),
          controllerLabel: spec.controllerLabel,
          groupPath,
          groupName: group.name,
        })
      }
    }
  }
  return leds
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
 *
 * Callers that boot a user ELF should also seed `trace` and `debug` — CTF
 * semihosting and DEBUG_THREAD_INFO are invisible in the tree but common on
 * A53 builds (see App.tsx).
 */
export function emphasisPanels(insights: DtsInsights): Set<PanelKind> {
  const ubiquitous = new Set<PanelKind>(['gnss', 'audio', 'net'])
  return new Set([...insights.panels].filter((kind) => !ubiquitous.has(kind)))
}

export function computeInsights(doc: DtsDocument): DtsInsights {
  const i2cBuses = collectI2cBuses(doc)
  const spiBuses = collectSpiBuses(doc)
  const uartBuses = collectUartBuses(doc)
  const gpioControllers = collectGpioControllers(doc)
  const canControllers = collectCanControllers(doc)
  const pwmLeds = collectPwmLeds(doc)
  const chosenTable = chosen(doc)

  const bridgedBuses = i2cBuses.filter((bus) => bus.bridged)
  const bridgedSlots = bridgedBuses.flatMap((bus) => bus.slots)
  const bridgedSpi = spiBuses.filter((bus) => bus.bridged)

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
  if (bridgedSpi.length > 0) panels.add('spi')
  if (bridgedSlots.some((slot) => slot.chipId !== undefined && SENSOR_CHIP_IDS.has(slot.chipId))) {
    panels.add('sensor')
  }
  if (canControllers.some((controller) => controller.bridged)) panels.add('can')
  if (gpioControllers.some((controller) => controller.bridged)) panels.add('gpio')
  if (gpioControllers.some((c) => c.bridged && c.buttons.length > 0)) panels.add('keys')
  if (gpioControllers.some((c) => c.bridged && c.buzzers.length > 0)) panels.add('buzzer')
  if (gpioControllers.some((c) => c.bridged && c.steppers.length > 0)) panels.add('stepper')
  if (hasOkayCompat(doc, 'adi,tmc50xx')) panels.add('stepper')
  const display = chosenTable['zephyr,display']
  if (display && compatibles(display).includes('solomon,ssd1306')) panels.add('oled')
  if (hasOkayCompat(doc, 'jhd,jhd1313') || hasOkayCompat(doc, 'ptc,pt6314') || hasOkayCompat(doc, 'gpio-7-segment')) {
    panels.add('auxdisplay')
  }
  // HT16K33 matrix, pwm-leds, and bridged gpio-leds all earn the LED panel slot.
  if (
    hasOkayCompat(doc, 'holtek,ht16k33') ||
    hasOkayCompat(doc, 'ti,lp5562') ||
    hasOkayCompat(doc, 'ti,lp5012') ||
    hasOkayCompat(doc, 'sct,sct2024') ||
    hasOkayCompat(doc, 'worldsemi,ws2812-spi') ||
    pwmLeds.length > 0 ||
    gpioControllers.some((c) => c.bridged && c.leds.length > 0)
  ) {
    panels.add('led')
  }
  if (hasOkayCompat(doc, 'nxp,pca9685-pwm')) panels.add('pwm')
  if (hasOkayCompat(doc, 'microchip,mcp4725')) panels.add('dac')
  if (hasOkayCompat(doc, 'maxim,max17048')) panels.add('fuel-gauge')
  if (hasOkayCompat(doc, 'zephyr,bt-hci-uart')) panels.add('bluetooth')
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
    spiBuses,
    uartBuses,
    gpioControllers,
    canControllers,
    pwmLeds,
    panels,
  }
}
