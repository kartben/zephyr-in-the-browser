/**
 * Trace → zbus without the canvas: the rows, what each row draws and where,
 * what the pointer is over, and what its tip says.
 *
 * Paint and hover read the same placements, so a tip always names what is
 * drawn under the pointer. zbus calls last microseconds, so at most zooms a bar
 * is a sliver with no room for a label. The tip is where the label goes, with
 * the one number worth having: how long it took, how long after the dispatcher
 * it came, or why it failed.
 */

import {
  fmtTime,
  threadLabel,
  zbusErrno,
  type Trace,
  type ZbusActivity,
  type ZbusAsyncRun,
  type ZbusCall,
  type ZbusNotify,
  type ZbusWake,
} from '@/ctf'
import type { ZbusObserverKind, ZbusTopology } from '@/debug/elfZbus'

export const LABEL_W = 156
export const AXIS_H = 28
const CHAN_H = 32
const OBS_H = 22
/** A wake's dot. */
export const DOT_R = 3
/** How far from a thing the pointer may be and still get its tip. */
const SNAP_PX = 6

export type Row =
  | { kind: 'chan'; chan: number; label: string; detail: string; group: number }
  | {
      kind: 'obs'
      chan: number
      obs: number
      label: string
      obsKind: ZbusObserverKind | null
      /** False for an observer only the trace knows: one added at run time. */
      inImage: boolean
      last: boolean
      group: number
    }

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`

/** Rows from the image's topology, plus any channel or observer only the trace knows. */
export function buildRows(topo: ZbusTopology | null, activity: ZbusActivity): Row[] {
  const rows: Row[] = []
  const channels: number[] = topo ? topo.channels.map((c) => c.addr >>> 0) : []
  for (const c of activity.calls) if (!channels.includes(c.chan)) channels.push(c.chan)

  channels.forEach((chan, group) => {
    const info = topo?.channelByAddr32.get(chan)
    const detail = info
      ? [
          info.messageSize !== null ? `${info.messageSize} B` : null,
          info.validator ? 'validated' : null,
          `${info.observers.length} obs`,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'not in the image'
    rows.push({ kind: 'chan', chan, label: info?.name ?? hex(chan), detail, group })

    const observers: number[] = info ? info.observers.map((o) => o.addr >>> 0) : []
    // Observers added at run time are not in the image: they show up when told.
    for (const c of activity.calls) {
      if (c.chan !== chan) continue
      for (const n of c.notifies) if (!observers.includes(n.obs)) observers.push(n.obs)
    }
    observers.forEach((obs, i) => {
      const o = topo?.observerByAddr32.get(obs)
      rows.push({
        kind: 'obs',
        chan,
        obs,
        label: o?.name ?? hex(obs),
        obsKind: o?.kind ?? null,
        inImage: o !== undefined,
        last: i === observers.length - 1,
        group,
      })
    })
  })
  return rows
}

export function rowHeight(r: Row): number {
  return r.kind === 'chan' ? CHAN_H : OBS_H
}

/** Something a row draws. */
export type ZbusItem =
  /** A call on the channel: publish or notify, or a thinner read, claim or finish. */
  | { kind: 'call'; call: ZbusCall }
  /** A claimed channel, from claim's return to the finish. */
  | { kind: 'held'; call: ZbusCall; until: number | null }
  /** What the dispatcher did for one observer, inside `call`. */
  | { kind: 'notify'; call: ZbusCall; notify: ZbusNotify }
  /** A subscriber's thread waking with the channel, after `after` told it. */
  | { kind: 'wake'; wake: ZbusWake; after: ZbusNotify | null }
  /** The read the woken thread made. */
  | { kind: 'read'; call: ZbusCall; wake: ZbusWake }
  /** An async listener's callback, run by its work queue. */
  | { kind: 'run'; run: ZbusAsyncRun; after: ZbusNotify | null }

/** An item and where it sits, in CSS px from its row's top. */
export interface Placed {
  item: ZbusItem
  t0: number
  /** Null while it has not ended. */
  t1: number | null
  /** A bar's top and height; a dot is centred on `top`. */
  top: number
  height: number
  dot: boolean
  /** Where the dashed hand-off line into it starts. */
  from: number | null
}

/**
 * What a row draws, in drawing order (later items sit on top). `calls` are the
 * row's channel's, in order of t0.
 */
export function rowItems(
  r: Row,
  calls: ZbusCall[],
  activity: ZbusActivity,
  topo: ZbusTopology | null,
): Placed[] {
  const h = rowHeight(r)
  const bar = (item: ZbusItem, t0: number, t1: number | null, top: number, height: number, from: number | null = null): Placed => ({
    item,
    t0,
    t1,
    top,
    height,
    dot: false,
    from,
  })
  const out: Placed[] = []

  if (r.kind === 'chan') {
    // A claim holds the channel from claim's return to finish.
    for (const c of calls) {
      if (c.op !== 'claim' || c.ret !== 0 || c.t1 === null) continue
      const fin = calls.find((f) => f.op === 'finish' && f.thread === c.thread && f.t0 >= c.t1!)
      const until = fin?.t0 ?? null
      out.push(bar({ kind: 'held', call: c, until }, c.t1, until, 4, h - 8))
    }
    for (const c of calls) {
      if (c.op === 'pub' || c.op === 'notify') out.push(bar({ kind: 'call', call: c }, c.t0, c.t1, 5, 13))
      else out.push(bar({ kind: 'call', call: c }, c.t0, c.t1, h - 9, 6))
    }
    return out
  }

  const mid = h / 2
  const told = calls.flatMap((call) =>
    call.notifies.filter((n) => n.obs === r.obs).map((notify) => ({ call, notify })),
  )
  const before = (t: number) => [...told].reverse().find((x) => x.notify.t0 <= t)?.notify ?? null
  // A listener's notification is its callback, so it is drawn taller.
  const listener = r.obsKind === 'listener'
  for (const { call, notify } of told) {
    out.push(bar({ kind: 'notify', call, notify }, notify.t0, notify.t1, listener ? mid - 5 : mid - 4, listener ? 10 : 8))
  }

  if (r.obsKind === 'subscriber' || r.obsKind === 'msg_subscriber' || r.obsKind === null) {
    for (const w of activity.wakes) {
      if (w.obs !== r.obs || w.chan !== r.chan) continue
      const after = before(w.t)
      out.push({ item: { kind: 'wake', wake: w, after }, t0: w.t, t1: w.t, top: mid, height: 0, dot: true, from: after?.t0 ?? null })
      // The read that follows, by the thread that woke.
      const read = calls.find((c) => c.op === 'read' && c.thread === w.thread && c.t0 >= w.t)
      if (read) out.push(bar({ kind: 'read', call: read, wake: w }, read.t0, read.t1, mid - 5, 10, w.t))
    }
  }
  if (r.obsKind === 'async_listener' || r.obsKind === null) {
    for (const run of activity.runs) {
      if (run.chan !== r.chan || topo?.observerByWork32.get(run.work)?.addr !== r.obs) continue
      const after = before(run.t0)
      out.push(bar({ kind: 'run', run, after }, run.t0, run.t1, mid - 5, 10, after?.t0 ?? null))
    }
  }
  return out
}

/** Every row's placements, for {@link buildRows}' rows. */
export function placeRows(rows: Row[], activity: ZbusActivity, topo: ZbusTopology | null): Placed[][] {
  const callsByChan = new Map<number, ZbusCall[]>()
  for (const c of activity.calls) {
    const list = callsByChan.get(c.chan) ?? []
    list.push(c)
    callsByChan.set(c.chan, list)
  }
  return rows.map((r) => rowItems(r, callsByChan.get(r.chan) ?? [], activity, topo))
}

/** The time axis the hit test measures with. */
export interface ZbusXScale {
  X: (t: number) => number
  plotLeft: number
  plotRight: number
  /** Where a thing that has not ended is drawn to. */
  openEnd: number
}

/** Where a placed item is drawn, in CSS px, `rowTop` being its row's top. */
export function placedBox(p: Placed, rowTop: number, scale: ZbusXScale) {
  const x0 = scale.X(p.t0)
  const x1 = p.dot ? x0 : Math.max(x0 + 2, scale.X(p.t1 ?? scale.openEnd))
  const r = p.dot ? DOT_R : 0
  return { x0: x0 - r, x1: x1 + r, y0: rowTop + p.top - r, y1: rowTop + p.top + p.height + r }
}

export interface ZbusHover {
  row: number
  rowTop: number
  /** Null over the name gutter. */
  placed: Placed | null
}

/**
 * What is under (x, y), with `y` already mapped through the vertical zoom.
 * Over the plot, the nearest item within a few pixels: on a tie, the narrowest
 * (a dot over the bar it sits on), then the one drawn last.
 */
export function zbusHitTest(
  rows: Row[],
  items: Placed[][],
  bodyTop: number,
  x: number,
  y: number,
  scale: ZbusXScale,
): ZbusHover | null {
  let rowTop = bodyTop
  for (let i = 0; i < rows.length; i++) {
    const h = rowHeight(rows[i]!)
    if (y < rowTop || y >= rowTop + h) {
      rowTop += h
      continue
    }
    if (x < LABEL_W) return { row: i, rowTop, placed: null }
    let best: Placed | null = null
    let bestScore = Infinity
    let bestWidth = Infinity
    for (const p of items[i] ?? []) {
      const box = placedBox(p, rowTop, scale)
      if (box.x1 < scale.plotLeft || box.x0 > scale.plotRight) continue
      const score = Math.max(0, box.x0 - x, x - box.x1) + Math.max(0, box.y0 - y, y - box.y1)
      if (score > SNAP_PX) continue
      const width = box.x1 - box.x0
      if (score < bestScore - 0.5 || (score <= bestScore + 0.5 && width <= bestWidth)) {
        best = p
        bestScore = score
        bestWidth = width
      }
    }
    return best ? { row: i, rowTop, placed: best } : null
  }
  return null
}

const OP: Record<ZbusCall['op'], string> = {
  pub: 'publish',
  notify: 'notify',
  read: 'read',
  claim: 'claim',
  finish: 'finish',
}

type Kind = ZbusObserverKind | 'unknown'

const KIND_NAME: Record<Kind, string> = {
  listener: 'listener',
  subscriber: 'subscriber',
  msg_subscriber: 'message subscriber',
  async_listener: 'async listener',
  unknown: 'observer',
}

const KIND_MEANS: Record<Kind, string> = {
  listener: 'runs inside the publish',
  subscriber: 'gets the channel, reads it later',
  msg_subscriber: 'gets its own copy of each message',
  async_listener: 'runs later, from a work queue',
  unknown: 'of a kind this page does not know',
}

/** What the dispatcher did for an observer of each kind. */
const TOLD: Record<Kind, string> = {
  listener: 'callback',
  subscriber: 'channel queued',
  msg_subscriber: 'message copied',
  async_listener: 'handed to its work queue',
  unknown: 'notified',
}

const ENOMSG = -35
const EAGAIN = -11
const ENOMEM = -12
const EBUSY = -16

const who = (tr: Trace, thread: number | null) => (thread !== null ? threadLabel(tr, thread) : 'ISR')

const done = (t0: number, t1: number | null) => (t1 === null ? null : fmtTime(t1 - t0))

/** Why a call failed, from where its errno can come from. */
function callFailure(c: ZbusCall, ret: number, topo: ZbusTopology | null): string {
  const errno = zbusErrno(ret)
  if (c.op === 'pub' || c.op === 'notify') {
    // An observer's failure is what the publish returns.
    const failed = c.notifies.find((n) => n.ret !== null && n.ret < 0)
    if (failed) return `${errno} from ${topo?.observerByAddr32.get(failed.obs)?.name ?? hex(failed.obs)}`
    // The validator and the message copy both come before anyone is told.
    if (c.notifies.length === 0 && c.op === 'pub' && ret === ENOMSG) return `${errno}: rejected by the validator`
    if (c.notifies.length === 0 && ret === ENOMEM) return `${errno}: no buffer for the message copy`
  }
  if (ret === EBUSY) return `${errno}: channel busy`
  if (ret === EAGAIN) return `${errno}: timed out waiting for the channel`
  return errno
}

function notifyFailure(kind: Kind, ret: number): string {
  const errno = zbusErrno(ret)
  if (kind === 'subscriber' && ret === ENOMSG) return `${errno}: queue full`
  if (kind === 'subscriber' && ret === EAGAIN) return `${errno}: queue full, timed out`
  if (ret === ENOMEM) return `${errno}: no buffer for its copy`
  return errno
}

function callTip(tr: Trace, topo: ZbusTopology | null, calls: ZbusCall[], c: ZbusCall): string[] {
  const head = `${OP[c.op]} · ${who(tr, c.thread)}`
  const took = done(c.t0, c.t1)
  if (took === null) return [head, 'still running']
  if (c.ret !== null && c.ret < 0) return [head, callFailure(c, c.ret, topo)]
  if (c.op === 'pub' || c.op === 'notify') {
    const n = c.notifies.length
    return [head, `${took}, told ${n} observer${n === 1 ? '' : 's'}`]
  }
  if (c.op === 'read') {
    // A read that starts while another thread publishes waits for its lock.
    const holder = calls.find(
      (p) =>
        (p.op === 'pub' || p.op === 'notify') &&
        p.chan === c.chan &&
        p.thread !== c.thread &&
        p.t0 <= c.t0 &&
        (p.t1 === null || p.t1 > c.t0),
    )
    if (holder) return [head, `${took}, began inside ${who(tr, holder.thread)}'s ${OP[holder.op]}`]
  }
  return [head, took]
}

/**
 * The tip for a hover: two short lines, what it is and the number that matters.
 * `calls` is every call in the trace, for a read that waited on a publish.
 */
export function zbusTip(
  tr: Trace,
  topo: ZbusTopology | null,
  calls: ZbusCall[],
  row: Row,
  placed: Placed | null,
): string[] {
  const kind: Kind = row.kind === 'obs' ? (row.obsKind ?? 'unknown') : 'unknown'
  if (!placed) {
    if (row.kind === 'chan') return [row.label, row.detail]
    if (!row.inImage) return [row.label, 'not in the image: added at run time']
    return [`${row.label} · ${KIND_NAME[kind]}`, KIND_MEANS[kind]]
  }

  const it = placed.item
  switch (it.kind) {
    case 'call':
    case 'read':
      return callTip(tr, topo, calls, it.call)
    case 'held':
      return [
        `claimed by ${who(tr, it.call.thread)}`,
        it.until === null ? 'still held' : `held ${fmtTime(it.until - placed.t0)}`,
      ]
    case 'notify': {
      const head = `${row.label} · ${TOLD[kind]}`
      const { notify, call } = it
      if (notify.ret !== null && notify.ret < 0) return [head, notifyFailure(kind, notify.ret)]
      const took = done(notify.t0, notify.t1)
      if (took === null) return [head, 'still running']
      return kind === 'listener' ? [head, `${took}, inside ${who(tr, call.thread)}'s ${OP[call.op]}`] : [head, took]
    }
    case 'wake': {
      const head = `${who(tr, it.wake.thread)} woke`
      if (it.after) return [head, `${fmtTime(it.wake.t - it.after.t0)} after the ${it.wake.msg ? 'copy' : 'queue put'}`]
      return it.wake.since !== null ? [head, `waited ${fmtTime(it.wake.t - it.wake.since)}`] : [head]
    }
    case 'run': {
      const head = `${row.label} · callback in ${who(tr, it.run.thread)}`
      const took = done(it.run.t0, it.run.t1)
      if (took === null) return [head, 'still running']
      return [head, it.after ? `${took}, ${fmtTime(it.run.t0 - it.after.t0)} after the hand-off` : took]
    }
  }
}
