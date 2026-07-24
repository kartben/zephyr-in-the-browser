/**
 * Read-side helpers over a parsed devicetree.
 *
 * All total: a lookup that cannot be answered returns undefined (or an empty
 * collection) instead of throwing, so callers can chain them over trees of
 * unknown shape — a user-dropped file is under no obligation to look like the
 * bundled ones.
 */

import type { DtsCell, DtsDocument, DtsNode, DtsProperty } from './model'

/** Absolute path of a node, `/soc/uart@9040000` style. */
export function pathOf(node: DtsNode): string {
  const parts: string[] = []
  for (let n: DtsNode | null = node; n && n.name !== '/'; n = n.parent) parts.unshift(n.name)
  return '/' + parts.join('/')
}

export function byPath(doc: DtsDocument, path: string): DtsNode | undefined {
  let node = doc.root
  for (const part of path.split('/').filter(Boolean)) {
    const next = node.children.find((c) => c.name === part)
    if (!next) return undefined
    node = next
  }
  return node
}

export function byLabel(doc: DtsDocument, label: string): DtsNode | undefined {
  return doc.labelIndex.get(label)
}

export function nodesByCompatible(doc: DtsDocument, compatible: string): DtsNode[] {
  return doc.compatIndex.get(compatible) ?? []
}

export function prop(node: DtsNode, name: string): DtsProperty | undefined {
  return node.properties.find((p) => p.name === name)
}

/** First string value of a property. */
export function stringProp(node: DtsNode, name: string): string | undefined {
  const value = prop(node, name)?.values.find((v) => v.kind === 'string')
  return value?.kind === 'string' ? value.value : undefined
}

/** Every string value of a property — `compatible` lists several. */
export function stringsProp(node: DtsNode, name: string): string[] {
  return (prop(node, name)?.values ?? []).flatMap((v) => (v.kind === 'string' ? [v.value] : []))
}

/** First numeric cell of a property, across its cell arrays. */
export function numberProp(node: DtsNode, name: string): number | undefined {
  for (const value of prop(node, name)?.values ?? []) {
    if (value.kind !== 'cells') continue
    for (const cell of value.cells) if (cell.kind === 'number') return cell.value
  }
  return undefined
}

/** Whether a boolean property is present (`gpio-controller;`). */
export function boolProp(node: DtsNode, name: string): boolean {
  return prop(node, name) !== undefined
}

export function compatibles(node: DtsNode): string[] {
  return stringsProp(node, 'compatible')
}

export function statusOf(node: DtsNode): string {
  return stringProp(node, 'status') ?? 'okay'
}

/** Enabled in devicetree terms: no `status`, or `status = "okay"`. */
export function isOkay(node: DtsNode): boolean {
  const status = statusOf(node)
  return status === 'okay' || status === 'ok'
}

/** Hex unit address (`tmp112@48` → 0x48), when it is a plain number. */
export function unitAddressNumber(node: DtsNode): number | undefined {
  if (node.unitAddress === undefined) return undefined
  return /^[0-9a-fA-F]+$/.test(node.unitAddress) ? parseInt(node.unitAddress, 16) : undefined
}

/**
 * First cell of `reg` — which is the device address for one-cell buses like
 * I2C. Deliberately no #address-cells arithmetic: the consumers here only care
 * about bus-child addresses, and those are single cells in every tree we read.
 */
export function regAddress(node: DtsNode): number | undefined {
  const first = numberProp(node, 'reg')
  return first ?? unitAddressNumber(node)
}

export function resolveRef(doc: DtsDocument, cell: DtsCell): DtsNode | undefined {
  if (cell.kind === 'ref') return byLabel(doc, cell.label)
  if (cell.kind === 'pathref') return byPath(doc, cell.path)
  return undefined
}

function refTable(doc: DtsDocument, nodeName: string): Record<string, DtsNode> {
  const table: Record<string, DtsNode> = {}
  const node = doc.root.children.find((c) => c.name === nodeName)
  for (const property of node?.properties ?? []) {
    for (const value of property.values) {
      // Both spellings appear in the wild: `&label` in sources, a plain path
      // string in dtlib's flattened output.
      const target =
        value.kind === 'ref'
          ? byLabel(doc, value.label)
          : value.kind === 'string'
            ? byPath(doc, value.value)
            : undefined
      if (target) table[property.name] = target
    }
  }
  return table
}

/** The `/aliases` table, resolved to nodes. */
export function aliases(doc: DtsDocument): Record<string, DtsNode> {
  return refTable(doc, 'aliases')
}

/** The `/chosen` table, resolved to nodes. */
export function chosen(doc: DtsDocument): Record<string, DtsNode> {
  return refTable(doc, 'chosen')
}

export interface GpioSpec {
  controller?: DtsNode
  /** The reference as written, useful even when the label resolves nowhere. */
  controllerLabel: string
  pin: number
  flags: number
}

/**
 * Decode a `gpios = <&ctrl pin flags &ctrl2 pin flags …>` property, consuming
 * `#gpio-cells` from each resolved controller (default 2: pin, flags).
 */
export function gpioSpecs(doc: DtsDocument, node: DtsNode, name = 'gpios'): GpioSpec[] {
  const specs: GpioSpec[] = []
  for (const value of prop(node, name)?.values ?? []) {
    if (value.kind !== 'cells') continue
    const cells = value.cells
    for (let i = 0; i < cells.length; ) {
      const head = cells[i]
      if (head.kind === 'number') {
        i++ // stray cell — tolerate and move on
        continue
      }
      const controller = resolveRef(doc, head)
      const width = (controller && numberProp(controller, '#gpio-cells')) ?? 2
      const args = cells.slice(i + 1, i + 1 + width)
      const pin = args[0]?.kind === 'number' ? args[0].value : undefined
      const flags = args[1]?.kind === 'number' ? args[1].value : 0
      if (pin !== undefined) {
        specs.push({
          controller,
          controllerLabel: head.kind === 'ref' ? head.label : head.path,
          pin,
          flags,
        })
      }
      i += 1 + width
    }
  }
  return specs
}
