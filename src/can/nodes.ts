/**
 * Page-side node presets.
 *
 * These are not scenarios and not personas. Each is a preset over the three
 * behaviour fields in {@link ./bus.ts} — `transmit`, `respondTo`, `acks` — and
 * each earns its place by being the counterpart a packaged sample needs, the
 * same reason `src/net/stack.ts` plays gateway and DNS. A node named for a
 * device it is not implies simulation depth that does not exist.
 */

import { ANY_ID, type CanFrame, type CanNodeSpec } from './bus'

export interface CanNodeType {
  id: string
  label: string
  /** Fields the Add row must show for this type. */
  fields: Array<'id' | 'period'>
  defaults: { id?: number; periodMs?: number }
  create(nodeId: string, opts: { id: number; periodMs: number }): CanNodeSpec
}

export const CAN_NODE_TYPES: CanNodeType[] = [
  {
    id: 'periodic',
    label: 'Periodic · transmits an ID',
    fields: ['id', 'period'],
    defaults: { id: 0x0a0, periodMs: 100 },
    create: (nodeId, o) => ({
      id: nodeId,
      name: 'Periodic',
      transmit: {
        id: o.id,
        periodMs: o.periodMs,
        // A counter is the most legible payload: consecutive frames differ, so
        // the trace shows liveness rather than a wall of identical bytes.
        data: (seq) => Uint8Array.from([seq & 0xff, 0, 0, 0, 0, 0, 0, 0]),
      },
    }),
  },
  {
    id: 'responder',
    label: 'Responder · replies to RTR',
    fields: ['id'],
    defaults: { id: 0x200 },
    create: (nodeId, o) => ({
      id: nodeId,
      name: 'Responder',
      respondTo: {
        id: o.id,
        reply: (f) => (f.rtr ? { id: f.id, ext: f.ext, rtr: false, data: PAYLOAD } : null),
      },
    }),
  },
  {
    id: 'counter',
    label: 'Counter · samples/can/counter',
    fields: [],
    defaults: {},
    create: (nodeId) => ({
      id: nodeId,
      name: 'Counter',
      // Deliberately id-agnostic: it echoes whatever arrives with the first
      // byte incremented, so it is the counter sample's partner without this
      // file having to know the sample's constants. Wildcard also means it
      // keeps working if the sample's ids ever change upstream.
      respondTo: {
        id: ANY_ID,
        reply: (f) => (f.rtr ? null : { ...f, data: increment(f.data) }),
      },
    }),
  },
  {
    id: 'listener',
    label: 'Listener · acks only',
    fields: [],
    defaults: {},
    create: (nodeId) => ({ id: nodeId, name: 'Listener' }),
  },
  {
    id: 'silent',
    label: 'Silent · listen-only, no ACK',
    fields: [],
    defaults: {},
    // Listen-only in CAN sends no dominant bit, ACK included. That is what
    // makes this different from Listener, and why a bus of nothing but Silent
    // nodes still drives the controller bus-off.
    create: (nodeId) => ({ id: nodeId, name: 'Silent', acks: false }),
  },
]

const PAYLOAD = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 1])

export function nodeType(id: string): CanNodeType | undefined {
  return CAN_NODE_TYPES.find((t) => t.id === id)
}

function increment(data: Uint8Array): Uint8Array {
  const out = Uint8Array.from(data)
  if (out.length > 0) out[0] = (out[0]! + 1) & 0xff
  return out
}

export type { CanFrame }
