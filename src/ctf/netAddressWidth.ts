/**
 * Zephyr's TSDL declares socket `address` fields as [46] (INET6_ADDRSTRLEN),
 * but `ctf_top.h` only emits that width when CONFIG_NET_IPV6=y. With IPv6 off
 * (this app's default `net.conf`) the guest writes 20-byte strings — and a
 * decoder that always trusts [46] loses stream sync on the first bind/sendto,
 * which kills Schedule as well as Networking.
 *
 * Only fields declared as [46] are ambiguous. Thread `name[20]` must not be
 * treated as a net-address field.
 */

import { makeEventDef, type EventDef, type FieldKind } from './metadata'
import type { FieldDecl, FieldType } from './types'

const NET_ADDR_WIDE = 46
const NET_ADDR_NARROW = 20

export type NetAddressWidth = 20 | 46

/** TSDL-declared wide net address string (may shrink to 20 when !IPV6). */
function isWideNetAddressString(kind: FieldKind): kind is { str: number } {
  return typeof kind === 'object' && kind.str === NET_ADDR_WIDE
}

function isNetAddressString(kind: FieldKind): kind is { str: number } {
  return (
    typeof kind === 'object' && (kind.str === NET_ADDR_WIDE || kind.str === NET_ADDR_NARROW)
  )
}

/** True when this event carries a TSDL [46] address field (needs width probe). */
export function hasNetAddressField(def: EventDef): boolean {
  return def.fields.some((f) => isWideNetAddressString(f.kind))
}

/** Rebuild a single event def with every net-address string set to `width`. */
export function withNetAddressWidth(def: EventDef, width: NetAddressWidth): EventDef {
  const fields: FieldDecl[] = def.fields.map(({ name, kind }) => {
    // Only rescale fields that are (or were) the TSDL [46] net address slot.
    if (isNetAddressString(kind) && (kind.str === NET_ADDR_WIDE || name === 'address')) {
      return [name, { str: width }]
    }
    if (typeof kind === 'object') return [name, { str: kind.str }]
    return [name, kind as FieldType]
  })
  return makeEventDef(def.eid, def.name, fields)
}

/** Mutate all defs in place so net-address strings use `width`. */
export function applyNetAddressWidth(defs: Map<number, EventDef>, width: NetAddressWidth): void {
  for (const [eid, def] of defs) {
    if (!def.fields.some((f) => isNetAddressString(f.kind) && (f.kind.str === NET_ADDR_WIDE || f.name === 'address'))) {
      continue
    }
    defs.set(eid, withNetAddressWidth(def, width))
  }
}

export type NetAddressProbe =
  | { kind: 'width'; width: NetAddressWidth; def: EventDef }
  | { kind: 'wait' }
  | { kind: 'desync' }

/**
 * Choose 20 vs 46 by peeking at the next record's event id after this body.
 *
 * @param peekEid - given the absolute offset where the next header would start,
 *   return that event id, or null if the buffer does not contain a full header.
 */
export function probeNetAddressWidth(
  defs: Map<number, EventDef>,
  def: EventDef,
  bodyOff: number,
  bodyAvail: number,
  peekEid: (nextHeaderOff: number) => number | null,
): NetAddressProbe {
  const wide = withNetAddressWidth(def, NET_ADDR_WIDE)
  const narrow = withNetAddressWidth(def, NET_ADDR_NARROW)

  if (bodyAvail < narrow.size) return { kind: 'wait' }

  const widePeek = bodyAvail >= wide.size ? peekEid(bodyOff + wide.size) : null
  const narrowPeek = bodyAvail >= narrow.size ? peekEid(bodyOff + narrow.size) : null

  if (widePeek != null && defs.has(widePeek)) {
    return { kind: 'width', width: NET_ADDR_WIDE, def: wide }
  }
  if (narrowPeek != null && defs.has(narrowPeek)) {
    return { kind: 'width', width: NET_ADDR_NARROW, def: narrow }
  }

  // Exact end-of-buffer (no following header).
  if (bodyAvail === narrow.size && narrow.size !== wide.size) {
    return { kind: 'width', width: NET_ADDR_NARROW, def: narrow }
  }
  if (bodyAvail === wide.size) {
    return { kind: 'width', width: NET_ADDR_WIDE, def: wide }
  }

  const wideFailed = bodyAvail >= wide.size && widePeek != null && !defs.has(widePeek)
  const narrowFailed = bodyAvail >= narrow.size && narrowPeek != null && !defs.has(narrowPeek)
  if (wideFailed && narrowFailed) return { kind: 'desync' }
  if (wideFailed && narrowPeek != null) return { kind: 'desync' }

  return { kind: 'wait' }
}
