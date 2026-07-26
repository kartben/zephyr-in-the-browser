/**
 * The wire format annotated samples speak.
 *
 * The guest writes OSC 9700 sequences onto the console UART:
 *
 *     ESC ] 9700 ; v=1;k=show;a=3 ESC \
 *
 * xterm.js hands the part after the ident to a registered handler, and
 * consuming it there means nothing is ever painted — the sample's own output
 * stays exactly as it would be without annotations, and a terminal that has
 * never heard of 9700 ignores the sequence anyway.
 *
 * Only ids cross the wire. The prose lives in an annotations.json fetched
 * beside the ELF (see catalog.ts), so the firmware pays four bytes per
 * annotation rather than a paragraph. That is also why the escaping rules
 * below barely matter in practice: almost every payload is digits.
 *
 * Pure and DOM-free on purpose — vitest runs in a node environment with no
 * jsdom, so everything testable lives here and attach.ts is the two-line
 * adapter onto xterm.
 */

/** Private OSC ident. Collides with nothing xterm.js, iTerm2 or VS Code use. */
export const OSC_IDENT = 9700

/** Protocol version the guest stamps on every record. */
export const PROTOCOL_VERSION = 1

/** One entry of the table the guest announces at boot. */
export interface AnnRecord {
  kind: 'ann'
  id: number
  /** Source line, for cross-checking against annotations.json. */
  line: number
}

/** Closes the boot announcement: this build linked in `count` annotations. */
export interface TableRecord {
  kind: 'table'
  count: number
}

/** Show an annotation, optionally freezing the machine on it. */
export interface ShowRecord {
  kind: 'show'
  id: number
  pause: boolean
}

/** Point the device dock at a panel without saying anything. */
export interface RevealRecord {
  kind: 'reveal'
  panel: string
}

/** A live value to attach to an annotation the reader is looking at. */
export interface ValueRecord {
  kind: 'value'
  id: number
  text: string
}

/** The walkthrough is over. */
export interface EndRecord {
  kind: 'end'
}

export type AnnotationRecord =
  | AnnRecord
  | TableRecord
  | ShowRecord
  | RevealRecord
  | ValueRecord
  | EndRecord

/**
 * Undo the guest's percent-escaping.
 *
 * The guest escapes by whitelist — anything outside `[A-Za-z0-9._~/-]` — so a
 * malformed sequence means a corrupted record rather than something to guess
 * at. Multi-byte UTF-8 arrives as consecutive `%XX`, which decodeURIComponent
 * reassembles.
 */
function unescapeValue(raw: string): string | null {
  if (!raw.includes('%')) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function parseFields(payload: string): Map<string, string> | null {
  const fields = new Map<string, string>()
  for (const part of payload.split(';')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    if (eq <= 0) return null
    const value = unescapeValue(part.slice(eq + 1))
    if (value === null) return null
    fields.set(part.slice(0, eq), value)
  }
  return fields
}

/** Parse a non-negative integer, rejecting anything else outright. */
function num(fields: Map<string, string>, key: string): number | null {
  const raw = fields.get(key)
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

/**
 * Decode one OSC payload — everything after `ESC ] 9700 ;`.
 *
 * Returns null for anything that is not a well-formed record of a version we
 * understand. An unrecognised `k` is null too rather than an error: a newer
 * guest may emit record kinds this page predates, and dropping them silently
 * is the right response.
 */
export function decodeRecord(payload: string): AnnotationRecord | null {
  const fields = parseFields(payload)
  if (fields === null) return null
  if (num(fields, 'v') !== PROTOCOL_VERSION) return null

  const kind = fields.get('k')
  switch (kind) {
    case 'ann': {
      const id = num(fields, 'a')
      const line = num(fields, 'l')
      return id === null || line === null ? null : { kind: 'ann', id, line }
    }
    case 'table': {
      const count = num(fields, 'n')
      return count === null ? null : { kind: 'table', count }
    }
    case 'show':
    case 'pause': {
      const id = num(fields, 'a')
      return id === null ? null : { kind: 'show', id, pause: kind === 'pause' }
    }
    case 'reveal': {
      const panel = fields.get('t')
      return panel ? { kind: 'reveal', panel } : null
    }
    case 'value': {
      const id = num(fields, 'a')
      const text = fields.get('d')
      return id === null || text === undefined ? null : { kind: 'value', id, text }
    }
    case 'end':
      return { kind: 'end' }
    default:
      return null
  }
}

/**
 * Build a record the way the guest would.
 *
 * Only the mock backend and the tests need this — the real emitter is C. It
 * exists so the walkthrough can be demonstrated on a bare checkout, with no
 * QEMU build, which is how most people will first see the feature.
 */
export function encodeRecord(record: AnnotationRecord): string {
  const esc = (s: string) => s.replace(/[^A-Za-z0-9._~/-]/g, (c) => encodeURIComponent(c))
  const head = `v=${PROTOCOL_VERSION};k=`
  switch (record.kind) {
    case 'ann':
      return `${head}ann;a=${record.id};l=${record.line}`
    case 'table':
      return `${head}table;n=${record.count}`
    case 'show':
      return `${head}${record.pause ? 'pause' : 'show'};a=${record.id}`
    case 'reveal':
      return `${head}reveal;t=${esc(record.panel)}`
    case 'value':
      return `${head}value;a=${record.id};d=${esc(record.text)}`
    case 'end':
      return `${head}end`
  }
}

/** Wrap a payload in the full escape sequence, as the guest puts it on the wire. */
export function encodeSequence(record: AnnotationRecord): string {
  return `\x1b]${OSC_IDENT};${encodeRecord(record)}\x1b\\`
}
