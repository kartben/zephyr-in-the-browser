/**
 * Sample first: the order the ▤ view puts its rows in.
 *
 * Class order (deviceTopology's CLASS_ORDER) suits a reference and fails a
 * first look. On the Cortex-M3 Button sample the terminal says "Press the
 * button" while the dock opened on Debug, the LEDs, three UARTs and seven GPIO
 * controllers, with the button most of a screen further down. So this pass,
 * run over the rows buildRowList built, leads with what the running sample is
 * about: the rows of its primaryPanels, in the order the sample lists them,
 * the instruments among them included. The instruments it does not name come
 * next, and everything else goes into one fold at the end, still grouped by
 * class.
 *
 * A pass of its own rather than part of classRows: which rows exist and how
 * they group is the inventory's business, and which of them lead is the
 * sample's. It works on whatever rows it is given, with or without a group
 * header over a class, and the ⌗ view never goes through it.
 */

import type { PanelKind } from '@/boards'
import type { DeviceNode, Row } from '@/deviceTopology'

type DeviceRow = Extract<Row, { kind: 'device' }>
type GroupRow = Extract<Row, { kind: 'group' }>

/** An instrument row as the pass sees it: its dock key and the kind naming it. */
export interface InstrumentSlot {
  key: string
  panelKind: PanelKind
}

/** A row at the top of the dock: one of the sample's devices or instruments. */
export type LeadRow = DeviceRow | { kind: 'instrument'; key: string }

export interface SampleFirst {
  /** The sample's own rows, devices and instruments, in primaryPanels order. */
  lead: LeadRow[]
  /** Keys of the instruments the sample does not name, in their usual order. */
  instruments: string[]
  /** Everything else, for the fold: class groups recounted, emptied ones dropped. */
  more: Row[]
  /** How many device rows the fold holds. */
  moreCount: number
}

/**
 * Whether a device row is one the running sample is about: its panel kind is
 * one the sample lists. A row whose bridge is not up yet has no panel kind (see
 * deviceTopology), so it waits in the fold until the bridge is.
 */
export function isLeadNode(
  node: Pick<DeviceNode, 'panelKind'>,
  primary: readonly PanelKind[],
): boolean {
  return node.panelKind !== undefined && primary.includes(node.panelKind)
}

/** A bus leads the parts on it that share its kind: the I²C bus, then the EEPROM. */
function busFirst(a: DeviceRow, b: DeviceRow): number {
  const bus = (row: DeviceRow) => (row.node.deviceClass.endsWith('-bus') ? 0 : 1)
  return bus(a) - bus(b)
}

/**
 * Split the ▤ view's rows into the sample's lead, the other instruments, and
 * the fold. `instruments` are the instrument rows on screen, in their usual
 * order; a kind the sample names twice, or a kind with nothing to show on this
 * board, simply adds nothing.
 */
export function sampleFirst(
  rows: readonly Row[],
  primary: readonly PanelKind[],
  instruments: readonly InstrumentSlot[],
): SampleFirst {
  const kinds = [...new Set(primary)]

  // Bucket the lead devices by kind, keeping their class order within one.
  const byKind = new Map<PanelKind, DeviceRow[]>()
  const lifted = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'device' || !isLeadNode(row.node, kinds)) continue
    const kind = row.node.panelKind!
    byKind.set(kind, [...(byKind.get(kind) ?? []), row])
    lifted.add(row.node.key)
  }

  const lead: LeadRow[] = []
  for (const kind of kinds) {
    // Flat at the top: the class group that nested a row is not around it.
    for (const row of [...(byKind.get(kind) ?? [])].sort(busFirst)) {
      lead.push({ kind: 'device', node: row.node, depth: 0 })
    }
    for (const slot of instruments) {
      if (slot.panelKind === kind) lead.push({ kind: 'instrument', key: slot.key })
    }
  }
  const named = new Set(lead.flatMap((row) => (row.kind === 'instrument' ? [row.key] : [])))

  // The fold: what is left of each class, under its header while it has any.
  const more: Row[] = []
  let moreCount = 0
  let group: GroupRow | null = null
  let members: DeviceRow[] = []
  const flush = () => {
    if (group && members.length > 0) more.push({ ...group, count: members.length })
    more.push(...members)
    group = null
    members = []
  }
  for (const row of rows) {
    if (row.kind === 'group') {
      flush()
      group = row
      continue
    }
    if (row.kind !== 'device') {
      flush()
      more.push(row)
      continue
    }
    // A row of another class than the open group stands on its own (a class
    // the inventory lists without a header).
    if (group && row.node.deviceClass !== group.deviceClass) flush()
    if (lifted.has(row.node.key)) continue
    moreCount += 1
    // Nested under a row that left for the top: nothing to nest under here.
    const orphan = row.node.parentKey !== undefined && lifted.has(row.node.parentKey)
    const kept: DeviceRow = orphan && row.depth > 0 ? { ...row, depth: 0 } : row
    if (group) members.push(kept)
    else more.push(kept)
  }
  flush()

  return {
    lead,
    instruments: instruments.filter((slot) => !named.has(slot.key)).map((slot) => slot.key),
    more,
    moreCount,
  }
}
