/**
 * One device inventory, two projections. The dock renders the same rows either
 * nested the way the devicetree nests them (the ⌗ view) or grouped by
 * peripheral class (the ▤ view); this module derives that inventory as pure
 * data — no React, no stores, no subscriptions.
 *
 * The parsed devicetree of the running build is the preferred source, the same
 * doctrine registry.ts and hostGpio.ts follow: when a zephyr.dts is loaded, its
 * nodes decide what exists and what everything is called — including buses this
 * page does not bridge, which are listed inert rather than hidden. Only when no
 * tree is known does a per-board static table reproduce the historical picture.
 *
 * Availability still gates what is *interactive*: a devicetree can promise a
 * bridge the runtime has not exposed (mock backend, early boot), and those rows
 * simply do not appear yet — the same progressive fill the panels always had.
 */

import type { PanelKind } from '@/boards'
import type { DeviceTreeState } from '@/devicetree'
import type { DtsDocument, DtsInsights, DtsNode, I2cSlot } from '@/dts'
import { byPath, chosen, compatibles, isEffectivelyOkay, nodesByCompatible, pathOf } from '@/dts'
import type { I2cChip } from '@/virtio/devices/i2c'
import type { ChipKind } from '@/virtio/devices/registry'
import { FALLBACK_DT_SLOTS, chipType } from '@/virtio/devices/registry'
import { isMemoryChip } from '@/virtio/devices/memory/model'
import { isSensorChip } from '@/virtio/devices/sensors/model'

export type DockView = 'devicetree' | 'classes'

/** Grouping key of the ▤ view. Friendly labels only (CLASS_LABELS). */
export type DeviceClass =
  | 'sensor'
  | 'display'
  | 'memory'
  | 'i2c-bus'
  | 'gpio'
  | 'gnss'
  | 'audio'
  | 'net'
  | 'serial'
  | 'other'

/** Which extracted panel body a row hosts (see components/dock/deviceBodies). */
export type BodyKind =
  | 'sensor'
  | 'memory'
  | 'oled'
  | 'i2c'
  | 'gpio'
  | 'gnss'
  | 'speaker'
  | 'mic'
  | 'net'

/** Which runtime bridges are actually live right now. */
export interface Availability {
  gnss: boolean
  gpio: boolean
  audio: boolean
  mic: boolean
  net: boolean
  i2c: boolean
  display: boolean
  input: boolean
}

export interface DeviceNode {
  /** Stable identity: expansion, visibility and float geometry key off this. */
  key: string
  /** Devicetree-flavoured primary name for the ⌗ view (`tmp112@48`). */
  nodeName: string
  /** Friendly primary name for the ▤ view ('TMP112 temperature'). */
  label: string
  compatible?: string
  deviceClass: DeviceClass
  /** Devicetree path, used for ⌗ ordering and nesting. */
  path: string
  /** Key of the row this one nests under in the ⌗ view (bus, GNSS's UART). */
  parentKey?: string
  /**
   * interactive: has live controls. inert: listed for topology completeness
   * (console UART, an unbridged bus). ghost: the devicetree declares it but
   * nothing answers on the bus — the NAK/bus-error demo, visible.
   */
  presence: 'interactive' | 'inert' | 'ghost'
  /** Short annotation ('→ terminal', 'on stage', 'NAK — detached'). */
  note?: string
  /** Small qualifier chip ('bus only' for an attached-but-undeclared part). */
  tag?: string
  body?: BodyKind
  /** ▤-view breadcrumb locating the row on the hardware ('virtio_i2c0 · 0x48'). */
  crumb?: string
  /** Live chip handle, for sensor/memory/oled bodies. */
  chip?: I2cChip
  /** Controller label scoping an 'i2c' body's roster/traffic. */
  busLabel?: string
  /** The legacy panel kind whose expand-on-boot rule this row inherits. */
  panelKind?: PanelKind
}

export interface DeviceInventory {
  nodes: DeviceNode[]
  source: 'devicetree' | 'fallback'
  /** Root `model` string, shown on the ⌗ view's root row. */
  rootName?: string
  /** The .dts file name, when a tree is loaded. */
  treeName?: string
}

export type Row =
  | { kind: 'device'; node: DeviceNode; depth: number }
  /** ⌗-view structural scaffolding: the root and shared ancestors like `soc`. */
  | { kind: 'struct'; key: string; name: string; depth: number; note?: string }
  /** ▤-view group header. */
  | { kind: 'group'; key: string; deviceClass: DeviceClass; label: string; count: number }

export const CLASS_LABELS: Record<DeviceClass, string> = {
  sensor: 'Sensors',
  display: 'Displays',
  memory: 'Memory',
  'i2c-bus': 'I²C buses',
  gpio: 'GPIO',
  gnss: 'GNSS',
  audio: 'Audio',
  net: 'Network',
  serial: 'Serial',
  other: 'Other devices',
}

const CLASS_ORDER: DeviceClass[] = [
  'sensor',
  'display',
  'memory',
  'i2c-bus',
  'gpio',
  'gnss',
  'audio',
  'net',
  'serial',
  'other',
]

const KIND_TO_CLASS: Record<ChipKind, DeviceClass> = {
  sensor: 'sensor',
  eeprom: 'memory',
  display: 'display',
}

/** Fallback compatibles for the page's chip models, when no tree names them. */
const CHIP_COMPAT: Record<string, string> = {
  tmp112: 'ti,tmp112',
  lm75: 'lm75',
  adxl345: 'adi,adxl345',
  lsm6dso: 'st,lsm6dso',
  at24: 'atmel,at24',
  ssd1306: 'solomon,ssd1306',
}

function hex(address: number): string {
  return address.toString(16).padStart(2, '0')
}

/** Duck-typed, like PeripheralPanels always did; the SSD1306 has no decl. */
function chipClass(chip: I2cChip): DeviceClass {
  if (isSensorChip(chip)) return 'sensor'
  if (isMemoryChip(chip)) return 'memory'
  if ('isOn' in chip && 'memory' in chip) return 'display'
  return 'other'
}

function chipBody(cls: DeviceClass): BodyKind | undefined {
  if (cls === 'sensor') return 'sensor'
  if (cls === 'memory') return 'memory'
  if (cls === 'display') return 'oled'
  return undefined
}

/** Which legacy PanelKind's expand-on-boot rule a chip row inherits. */
function chipPanelKind(cls: DeviceClass): PanelKind | undefined {
  if (cls === 'sensor') return 'sensor'
  if (cls === 'memory') return 'i2c'
  if (cls === 'display') return 'oled'
  return undefined
}

/** A DT-ish node name for a chip the tree does not declare (`tmp112@60`). */
function synthChipNodeName(chip: I2cChip): string {
  const stem = (chip.name.split(/[\s(]/)[0] || 'i2c-dev').toLowerCase()
  return `${stem}@${hex(chip.address)}`
}

interface Ids {
  used: Set<string>
}

function uniqueKey(ids: Ids, base: string): string {
  let key = base
  for (let n = 2; ids.used.has(key); n++) key = `${base}~${n}`
  ids.used.add(key)
  return key
}

/**
 * The chip rows under one live (bridged, bound) bus: every attached chip in
 * address order, interleaved with ghost rows for declared-but-unanswered slots.
 */
function liveBusChildren(
  ids: Ids,
  busKey: string,
  busLabel: string,
  busPath: string,
  slots: readonly I2cSlot[],
  chips: readonly I2cChip[],
): DeviceNode[] {
  const slotByAddr = new Map(slots.map((slot) => [slot.address, slot]))
  const chipByAddr = new Map(chips.map((chip) => [chip.address, chip]))
  const addresses = [...new Set([...slotByAddr.keys(), ...chipByAddr.keys()])].sort((a, b) => a - b)

  const rows: DeviceNode[] = []
  for (const address of addresses) {
    const slot = slotByAddr.get(address)
    const chip = chipByAddr.get(address)
    const crumb = `${busLabel} · 0x${hex(address)}`

    if (chip) {
      const cls = chipClass(chip)
      rows.push({
        key: uniqueKey(ids, `${busLabel}:${hex(address)}`),
        nodeName: slot?.nodeName ?? synthChipNodeName(chip),
        label: chip.name,
        compatible: slot?.compatible || undefined,
        deviceClass: cls,
        path: `${busPath}/${slot?.nodeName ?? synthChipNodeName(chip)}`,
        parentKey: busKey,
        presence: 'interactive',
        tag: slot ? undefined : 'bus only',
        body: chipBody(cls),
        crumb,
        chip,
        busLabel,
        panelKind: chipPanelKind(cls),
      })
      continue
    }

    // Declared in the tree, answered by nothing: the driver NAKs exactly like
    // the part fell off the board. Worth a row, not an omission.
    const declared = slot!
    const type = declared.chipId ? chipType(declared.chipId) : undefined
    rows.push({
      key: uniqueKey(ids, `${busLabel}:${hex(address)}`),
      nodeName: declared.nodeName,
      label: type?.label ?? declared.compatible ?? declared.nodeName,
      compatible: declared.compatible || undefined,
      deviceClass: type ? KIND_TO_CLASS[type.kind] : 'i2c-bus',
      path: `${busPath}/${declared.nodeName}`,
      parentKey: busKey,
      presence: 'ghost',
      note: 'NAK — detached',
      crumb,
      busLabel,
    })
  }
  return rows
}

function deriveFromTree(
  doc: DtsDocument,
  insights: DtsInsights,
  chips: readonly I2cChip[],
  avail: Availability,
): DeviceNode[] {
  const ids: Ids = { used: new Set() }
  const nodes: DeviceNode[] = []
  const byDtPath = new Map<string, DeviceNode>()

  const push = (node: DeviceNode) => {
    nodes.push(node)
    byDtPath.set(node.path, node)
    return node
  }

  const firstOkay = (...compats: string[]): DtsNode | undefined => {
    for (const compat of compats) {
      const node = nodesByCompatible(doc, compat).find(isEffectivelyOkay)
      if (node) return node
    }
    return undefined
  }

  const consoleNode = chosen(doc)['zephyr,console']
  if (consoleNode) {
    push({
      key: uniqueKey(ids, 'serial:console'),
      nodeName: consoleNode.name,
      label: 'Console UART',
      compatible: compatibles(consoleNode)[0],
      deviceClass: 'serial',
      path: pathOf(consoleNode),
      presence: 'inert',
      note: '→ terminal',
      crumb: consoleNode.labels[0],
    })
  }

  if (avail.gnss) {
    const gnss = firstOkay('gnss-nmea-generic')
    if (gnss) {
      // The point of the ⌗ view: the receiver really hangs off a UART. Give
      // that UART a row of its own (unless it happens to be the console).
      let parentKey: string | undefined
      const uart = gnss.parent
      if (uart && uart.name !== '/') {
        const uartPath = pathOf(uart)
        const existing = byDtPath.get(uartPath)
        parentKey =
          existing?.key ??
          push({
            key: uniqueKey(ids, `serial:${uart.labels[0] ?? uart.name}`),
            nodeName: uart.name,
            label: 'GNSS UART',
            compatible: compatibles(uart)[0],
            deviceClass: 'serial',
            path: uartPath,
            presence: 'inert',
            crumb: uart.labels[0],
          }).key
      }
      push({
        key: uniqueKey(ids, 'gnss'),
        nodeName: gnss.name,
        label: 'GNSS',
        compatible: compatibles(gnss)[0],
        deviceClass: 'gnss',
        path: pathOf(gnss),
        parentKey,
        presence: 'interactive',
        body: 'gnss',
        crumb: uart?.labels[0] ?? uart?.name,
        panelKind: 'gnss',
      })
    }
  }

  if (avail.audio) {
    const speaker = firstOkay('qemu,host-audio')
    if (speaker) {
      push({
        key: uniqueKey(ids, 'audio'),
        nodeName: speaker.name,
        label: 'Speaker',
        compatible: compatibles(speaker)[0],
        deviceClass: 'audio',
        path: pathOf(speaker),
        presence: 'interactive',
        body: 'speaker',
        crumb: speaker.labels[0],
        panelKind: 'audio',
      })
    }
  }
  if (avail.mic) {
    const mic = firstOkay('qemu,host-mic')
    if (mic) {
      push({
        key: uniqueKey(ids, 'mic'),
        nodeName: mic.name,
        label: 'Microphone',
        compatible: compatibles(mic)[0],
        deviceClass: 'audio',
        path: pathOf(mic),
        presence: 'interactive',
        body: 'mic',
        crumb: mic.labels[0],
        panelKind: 'audio',
      })
    }
  }

  if (avail.net) {
    const nic = firstOkay('virtio,net', 'ti,stellaris-ethernet')
    if (nic) {
      push({
        key: uniqueKey(ids, 'net'),
        nodeName: nic.name,
        label: 'Network',
        compatible: compatibles(nic)[0],
        deviceClass: 'net',
        path: pathOf(nic),
        presence: 'interactive',
        body: 'net',
        crumb: nic.labels[0],
        panelKind: 'net',
      })
    }
  }

  if (avail.display) {
    const display = firstOkay('qemu,ramfb', 'virtio,gpu')
    if (display) {
      push({
        key: uniqueKey(ids, 'display'),
        nodeName: display.name,
        label: 'Display',
        compatible: compatibles(display)[0],
        deviceClass: 'display',
        path: pathOf(display),
        presence: 'inert',
        note: 'on stage',
        crumb: display.labels[0],
      })
    }
  }

  if (avail.input) {
    const tablet = firstOkay('virtio,input')
    if (tablet) {
      push({
        key: uniqueKey(ids, 'input'),
        nodeName: tablet.name,
        label: 'Touch input',
        compatible: compatibles(tablet)[0],
        deviceClass: 'other',
        path: pathOf(tablet),
        presence: 'inert',
        note: '→ display touch',
        crumb: tablet.labels[0],
      })
    }
  }

  // GPIO controllers: the bridged one drives the panel; the rest of the tree's
  // controllers are still listed, inert — a user-dropped board file has them.
  let gpioBodyUsed = false
  for (const ctl of insights.gpioControllers) {
    const live = ctl.bridged && avail.gpio && !gpioBodyUsed
    if (ctl.bridged && !avail.gpio) continue
    if (live) gpioBodyUsed = true
    const pathParts = ctl.path.split('/').filter(Boolean)
    const nodeName = pathParts[pathParts.length - 1] ?? ctl.controllerLabel
    push({
      key: uniqueKey(ids, live ? 'gpio' : `gpio:${ctl.controllerLabel}`),
      nodeName,
      label: live ? 'GPIO' : ctl.controllerLabel,
      compatible: ctl.compatible || undefined,
      deviceClass: 'gpio',
      path: ctl.path,
      presence: live ? 'interactive' : 'inert',
      note: live ? undefined : 'no page model',
      body: live ? 'gpio' : undefined,
      crumb: ctl.controllerLabel,
      panelKind: live ? 'gpio' : undefined,
    })
  }

  // I2C buses: every enumerated bus gets a row; only the bridged, bound one is
  // live, with the page's chips (and the tree's unanswered slots) as children.
  let busBodyUsed = false
  for (const bus of insights.i2cBuses) {
    if (bus.bridged && !avail.i2c) continue
    const live = bus.bridged && avail.i2c && !busBodyUsed
    if (live) busBodyUsed = true
    const busNode = byPath(doc, bus.path)
    const busKey = uniqueKey(ids, bus.controllerLabel)
    push({
      key: busKey,
      nodeName: busNode?.name ?? bus.controllerLabel,
      label: bus.controllerLabel,
      compatible: bus.compatible || undefined,
      deviceClass: 'i2c-bus',
      path: bus.path,
      presence: live ? 'interactive' : 'inert',
      note: live ? undefined : 'no page model',
      body: live ? 'i2c' : undefined,
      busLabel: bus.controllerLabel,
      panelKind: live ? 'i2c' : undefined,
    })

    if (live) {
      for (const row of liveBusChildren(ids, busKey, bus.controllerLabel, bus.path, bus.slots, chips)) {
        push(row)
      }
    } else {
      for (const slot of bus.slots) {
        push({
          key: uniqueKey(ids, `${bus.controllerLabel}:${hex(slot.address)}`),
          nodeName: slot.nodeName,
          label: slot.nodeName,
          compatible: slot.compatible || undefined,
          deviceClass: 'i2c-bus',
          path: `${bus.path}/${slot.nodeName}`,
          parentKey: busKey,
          presence: 'inert',
          crumb: `${bus.controllerLabel} · 0x${hex(slot.address)}`,
          busLabel: bus.controllerLabel,
        })
      }
    }
  }

  return sortByDocumentOrder(nodes, doc)
}

/** Stable ⌗ ordering: the order nodes appear in the tree source. */
function sortByDocumentOrder(nodes: DeviceNode[], doc: DtsDocument): DeviceNode[] {
  const order = new Map<string, number>()
  let index = 0
  const walk = (node: DtsNode) => {
    order.set(pathOf(node), index++)
    node.children.forEach(walk)
  }
  walk(doc.root)

  // Children stay behind their parent regardless of raw position, so a chip
  // attached at a low address does not sort ahead of its bus row.
  const rank = new Map<string, number>()
  nodes.forEach((node, i) => rank.set(node.key, i))
  return [...nodes].sort((a, b) => {
    const pa = a.parentKey ? (rank.get(a.parentKey) ?? 0) : rank.get(a.key)!
    const pb = b.parentKey ? (rank.get(b.parentKey) ?? 0) : rank.get(b.key)!
    if (pa !== pb) {
      const oa = order.get(nodes[pa].path) ?? Number.MAX_SAFE_INTEGER
      const ob = order.get(nodes[pb].path) ?? Number.MAX_SAFE_INTEGER
      if (oa !== ob) return oa - ob
      return pa - pb
    }
    // Same top-level ancestor: parent first, then children in push order.
    if (a.parentKey && !b.parentKey) return 1
    if (!a.parentKey && b.parentKey) return -1
    return rank.get(a.key)! - rank.get(b.key)!
  })
}

/**
 * Names for the no-devicetree fallback, mirroring the bundled overlays the
 * same way FALLBACK_DT_SLOTS does. Availability decides which entries appear.
 */
interface FallbackNames {
  console: { nodeName: string; compatible: string; label?: string }
  gnssUart: { nodeName: string; compatible: string; label?: string }
  audio: { nodeName: string }
  mic: { nodeName: string }
  net: { nodeName: string; compatible: string; label: string }
  gpio: { nodeName: string; compatible: string; label: string }
  i2c: { nodeName: string; compatible: string; label: string; parentPath: string }
  display: { nodeName: string }
  input?: { nodeName: string }
}

const A53_FALLBACK: FallbackNames = {
  console: { nodeName: 'uart@9000000', compatible: 'arm,pl011', label: 'uart0' },
  gnssUart: { nodeName: 'uart@9040000', compatible: 'arm,pl011', label: 'uart1' },
  audio: { nodeName: 'audio@90d0000' },
  mic: { nodeName: 'audio@90e0000' },
  net: { nodeName: 'virtio-net', compatible: 'virtio,net', label: 'virtio_net0' },
  gpio: { nodeName: 'virtio-gpio', compatible: 'virtio,gpio', label: 'virtio_gpio0' },
  i2c: {
    nodeName: 'virtio-i2c',
    compatible: 'virtio,i2c',
    label: 'virtio_i2c0',
    parentPath: '/soc/virtio_mmio@a000800',
  },
  display: { nodeName: 'ramfb' },
  input: { nodeName: 'virtio-tablet' },
}

const M3_FALLBACK: FallbackNames = {
  console: { nodeName: 'uart@4000c000', compatible: 'ti,stellaris-uart', label: 'uart0' },
  gnssUart: { nodeName: 'uart@4000d000', compatible: 'ti,stellaris-uart', label: 'uart1' },
  audio: { nodeName: 'audio@40062000' },
  mic: { nodeName: 'audio@40063000' },
  net: { nodeName: 'ethernet@40048000', compatible: 'ti,stellaris-ethernet', label: 'eth0' },
  gpio: { nodeName: 'gpio@40061000', compatible: 'qemu,host-gpio', label: 'host_gpio' },
  i2c: {
    nodeName: 'virtio-i2c',
    compatible: 'virtio,i2c',
    label: 'virtio_i2c0',
    parentPath: '/soc',
  },
  display: { nodeName: 'ramfb' },
}

function deriveFallback(
  boardId: string,
  chips: readonly I2cChip[],
  avail: Availability,
): DeviceNode[] {
  const names = boardId === 'qemu_cortex_m3' ? M3_FALLBACK : A53_FALLBACK
  const ids: Ids = { used: new Set() }
  const nodes: DeviceNode[] = []

  nodes.push({
    key: uniqueKey(ids, 'serial:console'),
    nodeName: names.console.nodeName,
    label: 'Console UART',
    compatible: names.console.compatible,
    deviceClass: 'serial',
    path: `/soc/${names.console.nodeName}`,
    presence: 'inert',
    note: '→ terminal',
    crumb: names.console.label,
  })

  if (avail.gnss) {
    const uartKey = uniqueKey(ids, `serial:${names.gnssUart.label ?? names.gnssUart.nodeName}`)
    nodes.push({
      key: uartKey,
      nodeName: names.gnssUart.nodeName,
      label: 'GNSS UART',
      compatible: names.gnssUart.compatible,
      deviceClass: 'serial',
      path: `/soc/${names.gnssUart.nodeName}`,
      presence: 'inert',
      crumb: names.gnssUart.label,
    })
    nodes.push({
      key: uniqueKey(ids, 'gnss'),
      nodeName: 'gnss-nmea-generic',
      label: 'GNSS',
      compatible: 'gnss-nmea-generic',
      deviceClass: 'gnss',
      path: `/soc/${names.gnssUart.nodeName}/gnss-nmea-generic`,
      parentKey: uartKey,
      presence: 'interactive',
      body: 'gnss',
      crumb: names.gnssUart.label,
      panelKind: 'gnss',
    })
  }

  if (avail.audio) {
    nodes.push({
      key: uniqueKey(ids, 'audio'),
      nodeName: names.audio.nodeName,
      label: 'Speaker',
      compatible: 'qemu,host-audio',
      deviceClass: 'audio',
      path: `/soc/${names.audio.nodeName}`,
      presence: 'interactive',
      body: 'speaker',
      panelKind: 'audio',
    })
  }
  if (avail.mic) {
    nodes.push({
      key: uniqueKey(ids, 'mic'),
      nodeName: names.mic.nodeName,
      label: 'Microphone',
      compatible: 'qemu,host-mic',
      deviceClass: 'audio',
      path: `/soc/${names.mic.nodeName}`,
      presence: 'interactive',
      body: 'mic',
      panelKind: 'audio',
    })
  }

  if (avail.net) {
    nodes.push({
      key: uniqueKey(ids, 'net'),
      nodeName: names.net.nodeName,
      label: 'Network',
      compatible: names.net.compatible,
      deviceClass: 'net',
      path: `/soc/${names.net.nodeName}`,
      presence: 'interactive',
      body: 'net',
      crumb: names.net.label,
      panelKind: 'net',
    })
  }

  if (avail.gpio) {
    nodes.push({
      key: uniqueKey(ids, 'gpio'),
      nodeName: names.gpio.nodeName,
      label: 'GPIO',
      compatible: names.gpio.compatible,
      deviceClass: 'gpio',
      path: `/soc/${names.gpio.nodeName}`,
      presence: 'interactive',
      body: 'gpio',
      crumb: names.gpio.label,
      panelKind: 'gpio',
    })
  }

  if (avail.display) {
    nodes.push({
      key: uniqueKey(ids, 'display'),
      nodeName: names.display.nodeName,
      label: 'Display',
      compatible: 'qemu,ramfb',
      deviceClass: 'display',
      path: `/soc/${names.display.nodeName}`,
      presence: 'inert',
      note: 'on stage',
    })
  }

  if (avail.input && names.input) {
    nodes.push({
      key: uniqueKey(ids, 'input'),
      nodeName: names.input.nodeName,
      label: 'Touch input',
      compatible: 'virtio,input',
      deviceClass: 'other',
      path: `/soc/${names.input.nodeName}`,
      presence: 'inert',
      note: '→ display touch',
    })
  }

  if (avail.i2c) {
    const busPath = `${names.i2c.parentPath}/${names.i2c.nodeName}`
    const busKey = uniqueKey(ids, names.i2c.label)
    nodes.push({
      key: busKey,
      nodeName: names.i2c.nodeName,
      label: names.i2c.label,
      compatible: names.i2c.compatible,
      deviceClass: 'i2c-bus',
      path: busPath,
      presence: 'interactive',
      body: 'i2c',
      busLabel: names.i2c.label,
      panelKind: 'i2c',
    })
    const slots: I2cSlot[] = Object.entries(FALLBACK_DT_SLOTS).map(([address, chipId]) => ({
      address: Number(address),
      compatible: CHIP_COMPAT[chipId] ?? '',
      chipId,
      nodeName: `${chipId}@${hex(Number(address))}`,
    }))
    nodes.push(...liveBusChildren(ids, busKey, names.i2c.label, busPath, slots, chips))
  }

  return nodes
}

/**
 * The inventory: what the dock shows, before any view is chosen. Pure — the
 * caller (hooks/useDeviceTree) supplies the tree, the chips and availability.
 */
export function deriveDeviceInventory(
  tree: Pick<DeviceTreeState, 'name' | 'doc' | 'insights'> | null,
  chips: readonly I2cChip[],
  avail: Availability,
  boardId: string,
): DeviceInventory {
  if (tree?.doc && tree.insights) {
    return {
      nodes: deriveFromTree(tree.doc, tree.insights, chips, avail),
      source: 'devicetree',
      rootName: tree.insights.model,
      treeName: tree.name,
    }
  }
  return {
    nodes: deriveFallback(boardId, chips, avail),
    source: 'fallback',
  }
}

/**
 * Flatten the inventory into what one view renders, top to bottom. Both views
 * emit the same `device` rows (same keys, same nodes) — only the scaffolding
 * around them differs, which is what keeps a view flip a pure re-arrangement.
 */
export function buildRowList(inventory: DeviceInventory, view: DockView): Row[] {
  return view === 'devicetree' ? devicetreeRows(inventory) : classRows(inventory.nodes)
}

function devicetreeRows(inventory: DeviceInventory): Row[] {
  const { nodes } = inventory
  const rows: Row[] = []

  if (inventory.rootName || inventory.treeName) {
    rows.push({
      kind: 'struct',
      key: 'root',
      name: '/',
      depth: 0,
      note: [inventory.rootName, inventory.treeName].filter(Boolean).join(' — '),
    })
  }
  const baseDepth = rows.length > 0 ? 1 : 0

  const children = new Map<string, DeviceNode[]>()
  const topLevel: DeviceNode[] = []
  for (const node of nodes) {
    if (node.parentKey) {
      const list = children.get(node.parentKey) ?? []
      list.push(node)
      children.set(node.parentKey, list)
    } else {
      topLevel.push(node)
    }
  }

  // Shared first path segments (in practice: `soc`) become structural rows
  // when more than one top-level row lives under them.
  const segmentOf = (node: DeviceNode) => node.path.split('/').filter(Boolean)[0] ?? ''
  const segmentCounts = new Map<string, number>()
  for (const node of topLevel) {
    const seg = segmentOf(node)
    segmentCounts.set(seg, (segmentCounts.get(seg) ?? 0) + 1)
  }

  const emitted = new Set<string>()
  const emit = (node: DeviceNode, depth: number) => {
    rows.push({ kind: 'device', node, depth })
    for (const child of children.get(node.key) ?? []) emit(child, depth + 1)
  }

  for (const node of topLevel) {
    const seg = segmentOf(node)
    const grouped = seg !== '' && (segmentCounts.get(seg) ?? 0) >= 2
    if (grouped && !emitted.has(seg)) {
      emitted.add(seg)
      rows.push({ kind: 'struct', key: `struct:${seg}`, name: seg, depth: baseDepth })
    }
    emit(node, grouped ? baseDepth + 1 : baseDepth)
  }

  return rows
}

function classRows(nodes: DeviceNode[]): Row[] {
  const rows: Row[] = []
  const byKey = new Map(nodes.map((node) => [node.key, node]))

  for (const cls of CLASS_ORDER) {
    const members = nodes.filter((node) => node.deviceClass === cls)
    if (members.length === 0) continue
    rows.push({
      kind: 'group',
      key: `group:${cls}`,
      deviceClass: cls,
      label: CLASS_LABELS[cls],
      count: members.length,
    })
    for (const node of members) {
      // A row whose ⌗ parent landed in the same group (an unbridged bus's
      // slots under their bus) keeps one level of nesting; everything else is
      // flat — chips already carry their bus in the breadcrumb.
      const parent = node.parentKey ? byKey.get(node.parentKey) : undefined
      rows.push({ kind: 'device', node, depth: parent?.deviceClass === cls ? 1 : 0 })
    }
  }
  return rows
}
