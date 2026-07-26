/**
 * Parsed DTS model (syntax tree, not bindings). Properties keep decoded values
 * and verbatim `raw` text for exact viewer display.
 */

export interface DtsNode {
  /** Node name as written, without labels — `tmp112@48`; `/` for the root. */
  name: string
  /** Labels declared before the name (`virtio_i2c0:`); flattened files can carry several. */
  labels: string[]
  /** Text after `@` in the name, unparsed — addresses are not always numbers. */
  unitAddress?: string
  /** Ordered as written. Duplicate names keep the last value (dtc semantics). */
  properties: DtsProperty[]
  children: DtsNode[]
  parent: DtsNode | null
}

export interface DtsProperty {
  name: string
  /** Verbatim value source (text between `=` and `;`), '' for boolean props. */
  raw: string
  /** Decoded values; empty for boolean properties (`segment-remap;`). */
  values: DtsValue[]
}

export type DtsValue =
  | { kind: 'string'; value: string }
  /** A `< ... >` cell array. */
  | { kind: 'cells'; cells: DtsCell[] }
  /** A `[ 02 00 ... ]` byte string. */
  | { kind: 'bytes'; bytes: number[] }
  /** A bare `&label` value outside cells (aliases and chosen use these). */
  | { kind: 'ref'; label: string }

export type DtsCell =
  | { kind: 'number'; value: number }
  /** `&label` inside cells — a phandle reference. */
  | { kind: 'ref'; label: string }
  /** `&{/soc/...}` — a phandle reference by path. */
  | { kind: 'pathref'; path: string }

export interface DtsDocument {
  root: DtsNode
  /** Every label in the file, pointing at its node. */
  labelIndex: Map<string, DtsNode>
  /** Every string of every `compatible` property, pointing at its nodes. */
  compatIndex: Map<string, DtsNode[]>
}

/** Parse failure, with a 1-based source position for the message. */
export class DtsParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`${message} (line ${line}, column ${col})`)
    this.name = 'DtsParseError'
  }
}
