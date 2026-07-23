/** DNS server-side codec (RFC 1035): single-question queries, A answers. */

import { concat, viewOf } from './bytes'

export const DNS_TYPE_A = 1
export const DNS_TYPE_AAAA = 28

export interface DnsQuery {
  id: number
  /** Lower-cased dotted name. */
  name: string
  qtype: number
  /** The raw question section, echoed verbatim into the response. */
  question: Uint8Array
}

export function parseDnsQuery(payload: Uint8Array): DnsQuery | null {
  if (payload.length < 12) return null
  const view = viewOf(payload)
  const flags = view.getUint16(2)
  if ((flags & 0x8000) !== 0) return null // a response, not a query
  if (view.getUint16(4) < 1) return null // no question

  // Question names in queries are never compressed.
  const labels: string[] = []
  let i = 12
  while (i < payload.length) {
    const len = payload[i]
    if (len === 0) {
      i += 1
      break
    }
    if (len >= 0xc0 || i + 1 + len > payload.length) return null
    labels.push(new TextDecoder().decode(payload.subarray(i + 1, i + 1 + len)))
    i += 1 + len
  }
  if (i + 4 > payload.length) return null

  return {
    id: view.getUint16(0),
    name: labels.join('.').toLowerCase(),
    qtype: view.getUint16(i),
    question: payload.subarray(12, i + 4),
  }
}

/** NOERROR response; `ips` empty means an empty answer section (e.g. AAAA). */
export function buildDnsResponse(query: DnsQuery, ips: number[], ttl = 300): Uint8Array {
  const head = new Uint8Array(12)
  const view = viewOf(head)
  view.setUint16(0, query.id)
  view.setUint16(2, 0x8180) // response, RD+RA
  view.setUint16(4, 1)
  view.setUint16(6, ips.length)

  const answers = ips.map((ip) => {
    const a = new Uint8Array(16)
    const av = viewOf(a)
    av.setUint16(0, 0xc00c) // pointer to the name at offset 12
    av.setUint16(2, DNS_TYPE_A)
    av.setUint16(4, 1) // IN
    av.setUint32(6, ttl)
    av.setUint16(10, 4)
    av.setUint32(12, ip)
    return a
  })
  return concat(head, query.question, ...answers)
}

export function buildDnsNxdomain(query: DnsQuery): Uint8Array {
  const head = new Uint8Array(12)
  const view = viewOf(head)
  view.setUint16(0, query.id)
  view.setUint16(2, 0x8183) // response, RD+RA, NXDOMAIN
  view.setUint16(4, 1)
  return concat(head, query.question)
}
