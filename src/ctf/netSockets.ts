/**
 * Reconstruct per-socket timelines from Zephyr CTF socket_* / net_* events.
 *
 * Socket events carry fd (`id`), lengths, addresses, and results — not a
 * ready-made byte counter. We derive TX/RX samples from send/recv enter+exit
 * pairs and track identity from init/bind/connect/listen/accept/close.
 */

import { threadRunningAt, type Trace } from './reader'

export type SocketOp =
  | 'init'
  | 'bind'
  | 'connect'
  | 'listen'
  | 'accept'
  | 'send'
  | 'recv'
  | 'close'
  | 'shutdown'

export type SocketState = 'open' | 'listening' | 'connected' | 'closed'

export interface SockEndpoint {
  address: string
  port?: number
}

export interface SocketIdentity {
  /** File descriptor (CTF `id`, or accept result for new fds). */
  fd: number
  /** Generation bump when an fd is reused after close. */
  generation: number
  family: number
  type: number
  proto: number
  local: SockEndpoint | null
  peer: SockEndpoint | null
  state: SocketState
}

export interface SocketSample {
  ts: number
  op: SocketOp
  bytes: number
  ok: boolean
  address?: string
  threadId: number | null
}

export interface SocketSeries {
  key: string
  socket: SocketIdentity
  samples: SocketSample[]
  txBytes: number
  rxBytes: number
  errors: number
  firstTs: number
  lastTs: number
}

export interface NetCoreSample {
  ts: number
  dir: 'rx' | 'tx'
  bytes: number
  durationUs: number
  ok: boolean
  ifIndex: number
}

export interface NetCoreSeries {
  ifIndex: number
  samples: NetCoreSample[]
  rxBytes: number
  txBytes: number
}

/** Well-known AF / SOCK / IPPROTO labels for swimlane chrome. */
export function socketKindLabel(family: number, type: number, proto: number): string {
  const fam =
    family === 1 ? '' : family === 2 ? '4' : family === 10 || family === 28 ? '6' : `f${family}`
  let base = 'SOCK'
  if (type === 1) base = proto === 6 || proto === 0 ? 'TCP' : `STREAM${proto ? `/${proto}` : ''}`
  else if (type === 2) base = proto === 17 || proto === 0 ? 'UDP' : `DGRAM${proto ? `/${proto}` : ''}`
  else if (type === 3) base = 'RAW'
  else base = `t${type}`
  return `${base}${fam}`
}

export function socketLabel(s: SocketSeries): string {
  const kind = socketKindLabel(s.socket.family, s.socket.type, s.socket.proto)
  const ep = s.socket.local
  const where =
    ep?.address != null
      ? ep.port != null
        ? `${ep.address}:${ep.port}`
        : ep.address
      : s.socket.state === 'listening'
        ? 'listen'
        : '—'
  return `fd ${s.socket.fd}  ${kind}  ${where}`
}

function seriesKey(fd: number, generation: number): string {
  return `${fd}:${generation}`
}

type PendingIO = { op: 'send' | 'recv'; ts: number; bytes: number; address?: string }

type Acc = {
  socket: SocketIdentity
  samples: SocketSample[]
  txBytes: number
  rxBytes: number
  errors: number
  firstTs: number
  lastTs: number
  pending: PendingIO | null
}

function strField(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function numField(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function pushSample(a: Acc, sample: SocketSample) {
  a.samples.push(sample)
  a.lastTs = sample.ts
  if (!sample.ok) a.errors += 1
  if (sample.op === 'send' && sample.ok) a.txBytes += sample.bytes
  if (sample.op === 'recv' && sample.ok) a.rxBytes += sample.bytes
}

/**
 * Build one series per socket fd generation seen in the trace.
 * Matches on event **name** (metadata-backed), not hardcoded ids.
 */
export function reconstructSockets(tr: Trace): SocketSeries[] {
  const openByFd = new Map<number, Acc>()
  const closed: Acc[] = []
  const genByFd = new Map<number, number>()

  const ensureOpen = (fd: number, ts: number, init?: Partial<SocketIdentity>): Acc => {
    let a = openByFd.get(fd)
    if (a) return a
    const generation = genByFd.get(fd) ?? 0
    a = {
      socket: {
        fd,
        generation,
        family: init?.family ?? 0,
        type: init?.type ?? 0,
        proto: init?.proto ?? 0,
        local: init?.local ?? null,
        peer: init?.peer ?? null,
        state: init?.state ?? 'open',
      },
      samples: [],
      txBytes: 0,
      rxBytes: 0,
      errors: 0,
      firstTs: ts,
      lastTs: ts,
      pending: null,
    }
    openByFd.set(fd, a)
    return a
  }

  const closeFd = (fd: number, ts: number, ok: boolean) => {
    const a = openByFd.get(fd)
    if (!a) return
    a.socket.state = 'closed'
    pushSample(a, {
      ts,
      op: 'close',
      bytes: 0,
      ok,
      threadId: threadRunningAt(tr, ts),
    })
    openByFd.delete(fd)
    closed.push(a)
    genByFd.set(fd, a.socket.generation + 1)
  }

  for (const ev of tr.events) {
    const name = ev.name
    if (!name.startsWith('socket_') && !name.startsWith('net_')) continue

    if (name === 'socket_init') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      // Re-init of a live fd — close the previous generation first.
      if (openByFd.has(fd)) closeFd(fd, ev.ts, true)
      const a = ensureOpen(fd, ev.ts, {
        family: numField(ev.fields.family) ?? 0,
        type: numField(ev.fields.type) ?? 0,
        proto: numField(ev.fields.proto) ?? 0,
        state: 'open',
      })
      pushSample(a, {
        ts: ev.ts,
        op: 'init',
        bytes: 0,
        ok: true,
        threadId: threadRunningAt(tr, ev.ts),
      })
      continue
    }

    if (name === 'socket_bind_enter') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = ensureOpen(fd, ev.ts)
      const address = strField(ev.fields.address)
      const port = numField(ev.fields.port)
      a.socket.local = address != null ? { address, port } : a.socket.local
      pushSample(a, {
        ts: ev.ts,
        op: 'bind',
        bytes: 0,
        ok: true,
        address,
        threadId: threadRunningAt(tr, ev.ts),
      })
      continue
    }

    if (name === 'socket_connect_enter') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = ensureOpen(fd, ev.ts)
      const address = strField(ev.fields.address)
      if (address) a.socket.peer = { address }
      continue
    }

    if (name === 'socket_connect_exit') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = ensureOpen(fd, ev.ts)
      const result = numField(ev.fields.result) ?? -1
      const ok = result === 0
      if (ok) a.socket.state = 'connected'
      pushSample(a, {
        ts: ev.ts,
        op: 'connect',
        bytes: 0,
        ok,
        address: a.socket.peer?.address,
        threadId: threadRunningAt(tr, ev.ts),
      })
      continue
    }

    if (name === 'socket_listen_exit') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = ensureOpen(fd, ev.ts)
      const result = numField(ev.fields.result) ?? -1
      const ok = result === 0
      if (ok) a.socket.state = 'listening'
      pushSample(a, {
        ts: ev.ts,
        op: 'listen',
        bytes: 0,
        ok,
        threadId: threadRunningAt(tr, ev.ts),
      })
      continue
    }

    if (name === 'socket_accept_exit') {
      const listenFd = numField(ev.fields.id)
      const result = numField(ev.fields.result)
      if (listenFd == null || result == null) continue
      const address = strField(ev.fields.address)
      const port = numField(ev.fields.port)
      const listen = ensureOpen(listenFd, ev.ts)
      const ok = result >= 0
      pushSample(listen, {
        ts: ev.ts,
        op: 'accept',
        bytes: 0,
        ok,
        address,
        threadId: threadRunningAt(tr, ev.ts),
      })
      if (ok) {
        const child = ensureOpen(result, ev.ts, {
          family: listen.socket.family,
          type: listen.socket.type,
          proto: listen.socket.proto,
          local: listen.socket.local,
          peer: address != null ? { address, port } : null,
          state: 'connected',
        })
        pushSample(child, {
          ts: ev.ts,
          op: 'accept',
          bytes: 0,
          ok: true,
          address,
          threadId: threadRunningAt(tr, ev.ts),
        })
      }
      continue
    }

    if (
      name === 'socket_sendto_enter' ||
      name === 'socket_sendmsg_enter'
    ) {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = ensureOpen(fd, ev.ts)
      const bytes = numField(ev.fields.data_length) ?? 0
      const address = strField(ev.fields.address)
      if (address && !a.socket.peer) a.socket.peer = { address }
      a.pending = { op: 'send', ts: ev.ts, bytes, address }
      continue
    }

    if (name === 'socket_sendto_exit' || name === 'socket_sendmsg_exit') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = ensureOpen(fd, ev.ts)
      const result = numField(ev.fields.result) ?? -1
      const ok = result >= 0
      const pending = a.pending?.op === 'send' ? a.pending : null
      a.pending = null
      pushSample(a, {
        ts: ev.ts,
        op: 'send',
        bytes: ok ? result : pending?.bytes ?? 0,
        ok,
        address: pending?.address ?? a.socket.peer?.address,
        threadId: threadRunningAt(tr, ev.ts),
      })
      continue
    }

    if (
      name === 'socket_recvfrom_enter' ||
      name === 'socket_recvmsg_enter'
    ) {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = ensureOpen(fd, ev.ts)
      const bytes =
        numField(ev.fields.max_length) ??
        numField(ev.fields.max_msg_length) ??
        0
      a.pending = { op: 'recv', ts: ev.ts, bytes }
      continue
    }

    if (name === 'socket_recvfrom_exit' || name === 'socket_recvmsg_exit') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = ensureOpen(fd, ev.ts)
      const result = numField(ev.fields.result) ?? -1
      const ok = result >= 0
      const address = strField(ev.fields.address)
      const msgLen = numField(ev.fields.msg_length)
      a.pending = null
      pushSample(a, {
        ts: ev.ts,
        op: 'recv',
        bytes: ok ? (name === 'socket_recvmsg_exit' ? (msgLen ?? result) : result) : 0,
        ok,
        address,
        threadId: threadRunningAt(tr, ev.ts),
      })
      continue
    }

    if (name === 'socket_close_exit') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const result = numField(ev.fields.result) ?? 0
      closeFd(fd, ev.ts, result === 0)
      continue
    }

    if (name === 'socket_shutdown_exit') {
      const fd = numField(ev.fields.id)
      if (fd == null) continue
      const a = openByFd.get(fd)
      if (!a) continue
      const result = numField(ev.fields.result) ?? -1
      pushSample(a, {
        ts: ev.ts,
        op: 'shutdown',
        bytes: 0,
        ok: result === 0,
        threadId: threadRunningAt(tr, ev.ts),
      })
    }
  }

  const all = [...closed, ...openByFd.values()]
  const out: SocketSeries[] = all.map((a) => ({
    key: seriesKey(a.socket.fd, a.socket.generation),
    socket: a.socket,
    samples: a.samples,
    txBytes: a.txBytes,
    rxBytes: a.rxBytes,
    errors: a.errors,
    firstTs: a.firstTs,
    lastTs: a.lastTs,
  }))

  out.sort((a, b) => {
    if (a.firstTs !== b.firstTs) return a.firstTs - b.firstTs
    if (a.socket.fd !== b.socket.fd) return a.socket.fd - b.socket.fd
    return a.socket.generation - b.socket.generation
  })
  return out
}

/** Packet-level net_* samples for the latency / throughput strip. */
export function reconstructNetCore(tr: Trace): NetCoreSeries[] {
  const map = new Map<number, NetCoreSeries>()
  const pendingLen = new Map<string, number>()

  const ensure = (ifIndex: number): NetCoreSeries => {
    let s = map.get(ifIndex)
    if (!s) {
      s = { ifIndex, samples: [], rxBytes: 0, txBytes: 0 }
      map.set(ifIndex, s)
    }
    return s
  }

  for (const ev of tr.events) {
    const name = ev.name
    if (!name.startsWith('net_')) continue
    const ifIndex = numField(ev.fields.if_index) ?? -1
    const pkt = numField(ev.fields.pkt) ?? 0

    if (name === 'net_recv_data_enter' || name === 'net_send_data_enter') {
      const len = numField(ev.fields.pkt_len) ?? 0
      pendingLen.set(`${name}:${pkt}`, len)
      continue
    }

    if (name === 'net_recv_data_exit' || name === 'net_send_data_exit') {
      const dir = name.includes('recv') ? 'rx' : 'tx'
      const enterName = dir === 'rx' ? 'net_recv_data_enter' : 'net_send_data_enter'
      const bytes = pendingLen.get(`${enterName}:${pkt}`) ?? 0
      pendingLen.delete(`${enterName}:${pkt}`)
      const result = numField(ev.fields.result) ?? -1
      const ok = result === 0
      const s = ensure(ifIndex)
      s.samples.push({ ts: ev.ts, dir, bytes: ok ? bytes : 0, durationUs: 0, ok, ifIndex })
      if (ok) {
        if (dir === 'rx') s.rxBytes += bytes
        else s.txBytes += bytes
      }
      continue
    }

    if (name === 'net_rx_time' || name === 'net_tx_time') {
      const dir = name === 'net_rx_time' ? 'rx' : 'tx'
      const durationUs = numField(ev.fields.duration_us) ?? 0
      const s = ensure(ifIndex)
      s.samples.push({
        ts: ev.ts,
        dir,
        bytes: 0,
        durationUs,
        ok: true,
        ifIndex,
      })
    }
  }

  return [...map.values()].sort((a, b) => a.ifIndex - b.ifIndex)
}

/** Totals across socket series for the Trace metrics strip. */
export function socketWindowStats(
  series: SocketSeries[],
  view0: number,
  view1: number,
): { sockets: number; txBytes: number; rxBytes: number; errors: number } {
  let txBytes = 0
  let rxBytes = 0
  let errors = 0
  let sockets = 0
  for (const s of series) {
    if (s.lastTs < view0 || s.firstTs > view1) continue
    sockets += 1
    for (const sample of s.samples) {
      if (sample.ts < view0 || sample.ts > view1) continue
      if (sample.op === 'send' && sample.ok) txBytes += sample.bytes
      if (sample.op === 'recv' && sample.ok) rxBytes += sample.bytes
      if (!sample.ok) errors += 1
    }
  }
  return { sockets, txBytes, rxBytes, errors }
}

export function formatByteCount(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} KB`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)} MB`
}
