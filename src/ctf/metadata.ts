/**
 * Parse Zephyr's CTF TSDL metadata into per-event field layouts, and decode
 * fixed-size event bodies. Mirrors scripts/tracing/trace_viewer.py.
 */

import { FALLBACK_EVENTS, SCALAR_TYPES, type FieldDecl, type FieldType } from './types'

export type FieldKind = string | { str: number }

export interface EventDef {
  eid: number
  name: string
  fields: Array<{ name: string; kind: FieldKind }>
  size: number
}

function fieldSize(kind: FieldKind): number {
  if (typeof kind === 'object') return kind.str
  return SCALAR_TYPES[kind as Exclude<FieldType, 'str20'>]?.size ?? 0
}

export function makeEventDef(eid: number, name: string, fields: FieldDecl[]): EventDef {
  const parsed: EventDef['fields'] = []
  let size = 0
  for (const [fname, ftype] of fields) {
    if (ftype === 'str20' || (typeof ftype === 'object' && 'str' in ftype)) {
      const n = ftype === 'str20' ? 20 : ftype.str
      parsed.push({ name: fname, kind: { str: n } })
      size += n
    } else {
      parsed.push({ name: fname, kind: ftype })
      size += SCALAR_TYPES[ftype].size
    }
  }
  return { eid, name, fields: parsed, size }
}

export function fallbackDefs(): Map<number, EventDef> {
  const defs = new Map<number, EventDef>()
  for (const [eid, { name, fields }] of Object.entries(FALLBACK_EVENTS)) {
    defs.set(Number(eid), makeEventDef(Number(eid), name, fields))
  }
  return defs
}

/**
 * Decode fields from a little-endian buffer. Returns the field map and the
 * offset just past the last byte consumed.
 */
export function decodeFields(
  def: EventDef,
  buf: Uint8Array,
  off: number,
  view: DataView,
): { fields: Record<string, string | number>; next: number } {
  const fields: Record<string, string | number> = {}
  let o = off
  for (const { name, kind } of def.fields) {
    if (typeof kind === 'object') {
      const raw = buf.subarray(o, o + kind.str)
      o += kind.str
      let end = raw.indexOf(0)
      if (end < 0) end = raw.length
      fields[name] = new TextDecoder().decode(raw.subarray(0, end))
      continue
    }
    switch (kind) {
      case 'int8_t':
        fields[name] = view.getInt8(o)
        o += 1
        break
      case 'uint8_t':
        fields[name] = view.getUint8(o)
        o += 1
        break
      case 'uint16_t':
        fields[name] = view.getUint16(o, true)
        o += 2
        break
      case 'uint32_t':
        fields[name] = view.getUint32(o, true)
        o += 4
        break
      case 'int32_t':
        fields[name] = view.getInt32(o, true)
        o += 4
        break
      case 'uint64_t':
        // Timestamps use BigInt elsewhere; event bodies stay in Number range.
        fields[name] = Number(view.getBigUint64(o, true))
        o += 8
        break
      default:
        o += fieldSize(kind)
    }
  }
  return { fields, next: o }
}

/** Parse a TSDL metadata file into {id: EventDef}. */
export function parseMetadata(text: string): Map<number, EventDef> {
  const defs = new Map<number, EventDef>()
  const re = /\bevent\s*\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    let depth = 1
    let i = match.index + match[0].length
    const start = i
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
      i++
    }
    const body = text.slice(start, i - 1)
    const nameM = /name\s*=\s*([A-Za-z0-9_]+)\s*;/.exec(body)
    const idM = /id\s*=\s*(0[xX][0-9a-fA-F]+|\d+)\s*;/.exec(body)
    if (!nameM || !idM) continue
    const eid = Number.parseInt(idM[1]!, 0)
    const name = nameM[1]!
    const fields: FieldDecl[] = []
    const structM = /fields\s*:=\s*struct\s*\{([\s\S]*?)\}\s*;/.exec(body)
    if (structM) {
      const fieldRe =
        /([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[(\d+)\])?\s*;/g
      let fm: RegExpExecArray | null
      while ((fm = fieldRe.exec(structM[1]!))) {
        const ftype = fm[1]!
        const fname = fm[2]!
        const arr = fm[3]
        if (ftype === 'ctf_bounded_string_t') {
          // Thread names are [20]; socket addresses are [46] (INET6_ADDRSTRLEN).
          const n = arr ? Number(arr) : 20
          fields.push([fname, n === 20 ? 'str20' : { str: n }])
        } else if (ftype in SCALAR_TYPES || ftype === 'str20') {
          fields.push([fname, ftype as FieldType])
        }
      }
    }
    defs.set(eid, makeEventDef(eid, name, fields))
  }
  return defs
}

export async function loadEventDefs(metadataUrl: string): Promise<Map<number, EventDef>> {
  try {
    const res = await fetch(metadataUrl)
    if (!res.ok) return fallbackDefs()
    const text = await res.text()
    const defs = parseMetadata(text)
    return defs.size > 0 ? defs : fallbackDefs()
  } catch {
    return fallbackDefs()
  }
}
