/**
 * Synthetic Zephyr CTF for tests: records encoded from an event table, and a
 * small producer/consumer stream that exercises the scheduler, a msgq and ISRs.
 */

import { fallbackDefs, type EventDef } from '@/ctf'

/** One CTF record (64-bit timestamp, 16-bit id, packed fields) for `name` in `defs`. */
export function ctfRecord(
  defs: Map<number, EventDef>,
  name: string,
  ts: number,
  values: Record<string, number | string> = {},
): number[] {
  const def = [...defs.values()].find((d) => d.name === name)
  if (!def) throw new Error(`no ${name} in this table`)
  const view = new DataView(new ArrayBuffer(10 + def.size))
  view.setBigUint64(0, BigInt(ts), true)
  view.setUint16(8, def.eid, true)
  let off = 10
  for (const { name: field, kind } of def.fields) {
    const value = values[field] ?? 0
    if (typeof kind === 'object') {
      const text = String(value)
      for (let i = 0; i < kind.str; i++) view.setUint8(off + i, i < text.length ? text.charCodeAt(i) : 0)
      off += kind.str
      continue
    }
    switch (kind) {
      case 'int8_t':
        view.setInt8(off, Number(value))
        off += 1
        break
      case 'uint8_t':
        view.setUint8(off, Number(value))
        off += 1
        break
      case 'uint16_t':
        view.setUint16(off, Number(value), true)
        off += 2
        break
      case 'uint32_t':
        view.setUint32(off, Number(value) >>> 0, true)
        off += 4
        break
      case 'int32_t':
        view.setInt32(off, Number(value), true)
        off += 4
        break
      case 'uint64_t':
        view.setBigUint64(off, BigInt(value), true)
        off += 8
        break
    }
  }
  return [...new Uint8Array(view.buffer)]
}

export const PRODUCER = { thread_id: 0x1000, name: 'producer' }
export const CONSUMER = { thread_id: 0x2000, name: 'consumer' }
export const IDLE_THREAD = { thread_id: 0x3000, name: 'idle' }
export const MSGQ = 0x8000

/**
 * A producer handing a msgq message to a consumer that then blocks on it, with
 * a timer ISR per round: 17 records a round, timestamps 1 µs to 6 µs apart.
 * Uses only the fallback table, so it decodes the way hostTrace.debugFeed does.
 */
export function producerConsumer(rounds: number, startTs = 1_000_000): Uint8Array {
  const defs = fallbackDefs()
  const out: number[] = []
  let ts = startTs
  let n = 0
  const ev = (name: string, values: Record<string, number | string> = {}) => {
    out.push(...ctfRecord(defs, name, ts, values))
    ts += 1_000 + ((n * 7919) % 5_000)
    n++
  }
  for (let i = 0; i < rounds; i++) {
    ev('isr_enter')
    ev('isr_exit')
    ev('thread_switched_out', IDLE_THREAD)
    ev('thread_switched_in', PRODUCER)
    ev('msgq_put_enter', { id: MSGQ })
    ev('msgq_put_exit', { id: MSGQ, ret: 0 })
    ev('thread_sched_ready', CONSUMER)
    ev('thread_sleep_ticks_enter', { timeout: 10 })
    ev('thread_switched_out', PRODUCER)
    ev('thread_switched_in', CONSUMER)
    ev('msgq_get_enter', { id: MSGQ })
    ev('msgq_get_exit', { id: MSGQ, ret: 0 })
    ev('msgq_get_enter', { id: MSGQ })
    ev('msgq_get_blocking', { id: MSGQ })
    ev('thread_switched_out', CONSUMER)
    ev('thread_switched_in', IDLE_THREAD)
    ev('thread_sched_ready', PRODUCER)
  }
  return Uint8Array.from(out)
}
