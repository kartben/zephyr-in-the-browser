/**
 * Live-source decoding: the desktop bridge hands the reader CTF bytes from a
 * board that was already running, so the first byte is almost never a record
 * boundary. Getting that wrong reads payload as the 64-bit header timestamp.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseMetadata } from './metadata'
import { TraceReader } from './reader'

const defsText = readFileSync('public/tracing/metadata', 'utf8')
const realDefs = () => parseMetadata(defsText)

function encU16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}
function encU32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}
function encU64(n: number): number[] {
  const out = Array.from({ length: 8 }, () => 0)
  let x = n
  for (let i = 0; i < 8; i++) {
    out[i] = x & 0xff
    x = Math.floor(x / 256)
  }
  return out
}
function encName(s: string): number[] {
  const out = Array.from({ length: 20 }, () => 0)
  for (let i = 0; i < Math.min(20, s.length); i++) out[i] = s.charCodeAt(i)
  return out
}
function record(ts: number, eid: number, body: number[]): number[] {
  return [...encU64(ts), ...encU16(eid), ...body]
}

const MAIN = 0x20000100
const WORK = 0x20000280
const SEM = 0x20001a40
/** One second of board uptime, in ns — what timing_ns_get() would report. */
const BOOT_NS = 1_000_000_000

/** A plausible board stream: main/sysworkq switching around a semaphore. */
function stream(rounds = 12): { bytes: number[]; lastTs: number } {
  const out: number[] = []
  let ts = BOOT_NS
  out.push(...record(ts, 0x13, [...encU32(MAIN), ...encName('main')]))
  out.push(...record(ts, 0x13, [...encU32(WORK), ...encName('sysworkq')]))
  for (let i = 0; i < rounds; i++) {
    ts += 1_000_000
    out.push(...record(ts, 0x11, [...encU32(MAIN), ...encName('main')]))
    ts += 250_000
    // semaphore_take_enter: uint32 id, uint32 timeout — sized per the TSDL, so
    // this stream is well formed and only the attach offset is in question.
    out.push(...record(ts, 0x24, [...encU32(SEM), ...encU32(0)]))
    ts += 750_000
    out.push(...record(ts, 0x10, [...encU32(MAIN), ...encName('main')]))
    out.push(...record(ts, 0x11, [...encU32(WORK), ...encName('sysworkq')]))
    ts += 1_000_000
    out.push(...record(ts, 0x10, [...encU32(WORK), ...encName('sysworkq')]))
  }
  return { bytes: out, lastTs: ts }
}

/** Three years of uptime in ns — past this a "timestamp" is really payload. */
const ABSURD_NS = 1e17

describe('TraceReader, live byte source', () => {
  it('never invents a timestamp, whatever byte the attach lands on', () => {
    const { bytes, lastTs } = stream()
    const bad: Array<{ cut: number; t0: number; t1: number }> = []
    let recovered = 0
    for (let cut = 1; cut < 200; cut++) {
      const reader = new TraceReader(realDefs(), true, true)
      reader.feed(Uint8Array.from(bytes.slice(cut)))
      const { t0, t1, events } = reader.tr
      if (!events.length) continue
      recovered++
      if (t0 < BOOT_NS || t1 > lastTs || t1 < t0) bad.push({ cut, t0, t1 })
    }
    expect(bad).toEqual([])
    // Recovery, not silence: sliding to the next boundary costs a record or
    // two, never the stream.
    expect(recovered).toBeGreaterThan(190)
  })

  it('resumes on the next real boundary after a mid-stream byte drop', () => {
    const { bytes, lastTs } = stream()
    const reader = new TraceReader(realDefs(), true, true)
    const cutAt = 34 * 6
    reader.feed(Uint8Array.from(bytes.slice(0, cutAt)))
    const t0 = reader.tr.t0
    reader.feed(Uint8Array.from(bytes.slice(cutAt + 1)))
    expect(reader.tr.t0).toBe(t0)
    expect(reader.tr.t1).toBeLessThanOrEqual(lastTs)
    expect(reader.tr.events.length).toBeGreaterThan(40)
  })

  it('does not fold a bogus header into the epoch of every later event', () => {
    // Regression: one payload-as-timestamp record used to look like a counter
    // restart, so `tsOff` absorbed ~7e18 ns and never let go.
    const { bytes, lastTs } = stream()
    const reader = new TraceReader(realDefs(), true, true)
    reader.feed(Uint8Array.from(bytes.slice(9)))
    for (const ev of reader.tr.events) {
      expect(ev.ts).toBeLessThan(ABSURD_NS)
      expect(ev.ts).toBeGreaterThanOrEqual(BOOT_NS)
      expect(ev.ts).toBeLessThanOrEqual(lastTs)
    }
  })

  it('still follows a real 32-bit counter restart', () => {
    const defs = realDefs()
    const reader = new TraceReader(defs, true, true)
    // Enough aligned records to sync, then the counter restarts near zero.
    const before: number[] = []
    for (let i = 0; i < 6; i++) {
      before.push(...record(4_000_000_000 + i * 1_000_000, 0x11, [...encU32(MAIN), ...encName('main')]))
    }
    reader.feed(Uint8Array.from(before))
    const beforeEnd = reader.tr.t1
    const after: number[] = []
    for (let i = 0; i < 6; i++) {
      after.push(...record(1_000_000 + i * 1_000_000, 0x11, [...encU32(MAIN), ...encName('main')]))
    }
    reader.feed(Uint8Array.from(after))
    // Time keeps moving forward across the restart instead of jumping back.
    expect(reader.tr.t1).toBeGreaterThan(beforeEnd)
    expect(reader.tr.t1).toBeLessThan(ABSURD_NS)
  })

  it('leaves a file source (guest semihosting) decoding from byte 0 as before', () => {
    const { bytes } = stream(3)
    const live = new TraceReader(realDefs(), true, true)
    const file = new TraceReader(realDefs())
    expect(file.feed(Uint8Array.from(bytes))).toBe(live.feed(Uint8Array.from(bytes)))
    expect(file.tr.t0).toBe(BOOT_NS)
    expect(file.desync).toBe(false)
  })
})
