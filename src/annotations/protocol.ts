/**
 * Annotation wire format: guest writes OSC 9700 records onto the console UART:
 *
 *     ESC ] 9700 ; v=1;k=show;a=3 ESC \
 *
 * Only ids cross the wire; prose lives in annotations.json beside the ELF.
 */

export const OSC_IDENT = 9700

export const PROTOCOL_VERSION = 1

export interface AnnRecord {
  kind: 'ann'
  id: number
  line: number
}

export interface TableRecord {
  kind: 'table'
  count: number
}

export interface ShowRecord {
  kind: 'show'
  id: number
  pause: boolean
}

export interface RevealRecord {
  kind: 'reveal'
  panel: string
}

export interface ValueRecord {
  kind: 'value'
  id: number
  text: string
}

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

// Guest escapes anything outside [A-Za-z0-9._~/-]; malformed UTF-8 drops the record.
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

function num(fields: Map<string, string>, key: string): number | null {
  const raw = fields.get(key)
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

/**
 * Decode one OSC payload — everything after `ESC ] 9700 ;`.
 *
 * Null means malformed, unsupported version, or a newer record kind.
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

export function encodeSequence(record: AnnotationRecord): string {
  return `\x1b]${OSC_IDENT};${encodeRecord(record)}\x1b\\`
}
