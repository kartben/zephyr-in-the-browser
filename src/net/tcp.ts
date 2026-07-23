/**
 * A small, symmetric TCP engine for the browser-side network.
 *
 * The wire is lossless, in-order and has ~zero RTT (both ends live in the
 * same page), so this deliberately implements the RFC 9293 state machine
 * minus everything that exists to survive a real internet: no SACK, no
 * congestion control, no Nagle, no delayed ACKs, no reassembly queue
 * (out-of-order segments are dropped and retransmitted — reachable only
 * under user-configured impairments or guest packet-pool exhaustion).
 *
 * "Symmetric" because the same engine terminates connections on both ends:
 * the page's network stack uses it to be every remote host at once (and to
 * dial INTO guest servers), and the mock backend's fake guest reuses it as
 * its own TCP so the demo path exercises the real implementation.
 */

import { type TcpSegment, TCP_ACK, TCP_FIN, TCP_RST, TCP_SYN, TCP_PSH } from './tcpWire'

export type TcpState =
  | 'SYN_SENT'
  | 'SYN_RCVD'
  | 'ESTABLISHED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSE_WAIT'
  | 'CLOSING'
  | 'LAST_ACK'
  | 'TIME_WAIT'
  | 'CLOSED'

export interface TcpEndpoint {
  ip: number
  port: number
}

/** A segment the engine wants on the wire; the owner wraps it in IP/Ethernet. */
export interface TcpEmit {
  src: TcpEndpoint
  dst: TcpEndpoint
  seg: TcpSegment
}

export interface TcpHooks {
  emit(out: TcpEmit): void
  now(): number
  /** Initial sequence numbers; injected for deterministic tests. */
  randomSeq(): number
}

/**
 * Handlers receive the socket as their first argument: with a synchronous
 * wire (loopback, mock) they can fire before connect()/listen() returns,
 * so closing over a `const socket = connect(...)` binding is a TDZ trap.
 */
export interface TcpSocketHandlers {
  onOpen?: (socket: TcpSocket) => void
  onData?: (socket: TcpSocket, data: Uint8Array) => void
  /** The peer sent FIN: no more data will arrive (we may still send). */
  onRemoteClose?: (socket: TcpSocket) => void
  /** Full teardown — graceful or after a reset. Fires exactly once. */
  onClose?: (socket: TcpSocket) => void
  onReset?: (socket: TcpSocket) => void
}

const MSS = 1460
const WINDOW = 65535
const RTO_MS = 500
const MAX_RETRIES = 5
const TIME_WAIT_MS = 500

/* 32-bit modular sequence arithmetic. */
const seqAdd = (a: number, n: number) => (a + n) >>> 0
const seqDiff = (a: number, b: number) => (a - b) | 0 // signed distance a-b

export class TcpSocket {
  readonly local: TcpEndpoint
  readonly remote: TcpEndpoint
  handlers: TcpSocketHandlers = {}

  state: TcpState
  private engine: TcpEngine

  /** Send side: bytes from sndUna onward, unacked-then-unsent. */
  private sendChunks: Uint8Array[] = []
  private sendTotal = 0
  private sndUna: number
  private sndNxt: number
  private peerAckLimit = 0 // peer's ack + window: highest seq we may send
  private peerMss = MSS
  private finQueued = false
  private finSent = false
  private closed = false // onClose delivered

  /** Receive side. */
  private rcvNxt = 0

  /** Retransmit bookkeeping. */
  private rtoDeadline = 0
  private retries = 0
  private timeWaitDeadline = 0

  constructor(engine: TcpEngine, local: TcpEndpoint, remote: TcpEndpoint, state: TcpState, iss: number) {
    this.engine = engine
    this.local = local
    this.remote = remote
    this.state = state
    this.sndUna = iss
    this.sndNxt = iss
  }

  send(data: Uint8Array): void {
    if (this.finQueued || this.state === 'CLOSED' || this.state === 'TIME_WAIT') return
    if (data.length === 0) return
    this.sendChunks.push(data)
    this.sendTotal += data.length
    this.pump()
  }

  /** Graceful close: FIN once the send queue drains. */
  close(): void {
    if (this.finQueued) return
    this.finQueued = true
    this.pump()
  }

  abort(): void {
    if (this.state === 'CLOSED') return
    this.emitSeg({ flags: TCP_RST | TCP_ACK, seq: this.sndNxt, ack: this.rcvNxt })
    this.engine._drop(this)
    this.enterClosed(false)
  }

  /** Bytes accepted by send() but not yet acknowledged by the peer. */
  bufferedAmount(): number {
    return this.sendTotal
  }

  /* ---- internals (called from the engine) ---- */

  // Every emit below mutates state BEFORE the segment leaves: in loopback
  // and mock wiring hooks.emit delivers synchronously, so the reply can
  // re-enter _onSegment while the emitting call is still on the stack.

  _startConnect(): void {
    const iss = this.sndNxt
    this.sndNxt = seqAdd(iss, 1)
    this.armRto()
    this.emitSeg({ flags: TCP_SYN, seq: iss, ack: 0, mss: MSS })
  }

  _startAccept(mss: number | undefined, remoteSeq: number): void {
    this.peerMss = Math.min(mss ?? MSS, MSS)
    this.rcvNxt = seqAdd(remoteSeq, 1)
    const iss = this.sndNxt
    this.sndNxt = seqAdd(iss, 1)
    this.armRto()
    this.emitSeg({ flags: TCP_SYN | TCP_ACK, seq: iss, ack: this.rcvNxt, mss: MSS })
  }

  _onSegment(seg: TcpSegment): void {
    if (seg.flags & TCP_RST) {
      if (this.state === 'SYN_SENT' && !(seg.flags & TCP_ACK)) return
      this.engine._drop(this)
      this.handlers.onReset?.(this)
      this.enterClosed(true)
      return
    }

    if (this.state === 'SYN_SENT') {
      if ((seg.flags & (TCP_SYN | TCP_ACK)) !== (TCP_SYN | TCP_ACK)) return
      if (seg.ack !== this.sndNxt) return
      this.peerMss = Math.min(seg.mss ?? MSS, MSS)
      this.sndUna = seg.ack
      this.rcvNxt = seqAdd(seg.seq, 1)
      this.peerAckLimit = seqAdd(seg.ack, seg.window)
      this.clearRto()
      this.state = 'ESTABLISHED'
      this.sendAck()
      this.handlers.onOpen?.(this)
      this.pump()
      return
    }

    if (this.state === 'SYN_RCVD' && seg.flags & TCP_SYN) {
      // Duplicate SYN: our SYN-ACK was lost; resend it.
      this.emitSeg({ flags: TCP_SYN | TCP_ACK, seq: seqAdd(this.sndNxt, -1), ack: this.rcvNxt, mss: MSS })
      return
    }

    /* ---- ACK processing ---- */
    if (seg.flags & TCP_ACK) {
      const acked = seqDiff(seg.ack, this.sndUna)
      const inflight = seqDiff(this.sndNxt, this.sndUna)
      if (acked > 0 && acked <= inflight) {
        let dataAcked = acked
        // A FIN or SYN in flight occupies the final sequence slot.
        if ((this.finSent || this.state === 'SYN_RCVD') && seg.ack === this.sndNxt) dataAcked -= 1
        this.consumeAcked(dataAcked)
        this.sndUna = seg.ack
        this.retries = 0
        if (seqDiff(this.sndNxt, this.sndUna) === 0) this.clearRto()
        else this.armRto()
      }
      this.peerAckLimit = seqAdd(seg.ack, seg.window)

      if (this.state === 'SYN_RCVD' && seg.ack === this.sndNxt) {
        this.state = 'ESTABLISHED'
        this.clearRto()
        this.handlers.onOpen?.(this)
      }
      const finAcked = this.finSent && this.sndUna === this.sndNxt
      if (this.state === 'FIN_WAIT_1' && finAcked) this.state = 'FIN_WAIT_2'
      else if (this.state === 'CLOSING' && finAcked) this.enterTimeWait()
      else if (this.state === 'LAST_ACK' && finAcked) {
        this.engine._drop(this)
        this.enterClosed(true)
        return
      }
    }

    /* ---- payload ---- */
    let payload = seg.payload
    const behind = seqDiff(this.rcvNxt, seg.seq)
    if (behind < 0) {
      // A gap: drop, the peer retransmits (impairments only on this wire).
      this.sendAck()
      return
    }
    if (behind > 0) {
      // Duplicate or overlapping: re-ACK what we have (this also answers
      // retransmitted FINs), then trim the stale prefix.
      this.sendAck()
      payload = behind >= payload.length ? new Uint8Array(0) : payload.subarray(behind)
    }

    if (payload.length > 0) {
      this.rcvNxt = seqAdd(this.rcvNxt, payload.length)
      this.sendAck()
      this.handlers.onData?.(this, payload)
    }

    if (seg.flags & TCP_FIN && seqDiff(seqAdd(seg.seq, seg.payload.length), this.rcvNxt) === 0) {
      this.rcvNxt = seqAdd(this.rcvNxt, 1)
      this.sendAck()
      const finAcked = this.finSent && this.sndUna === this.sndNxt
      if (this.state === 'ESTABLISHED') this.state = 'CLOSE_WAIT'
      else if (this.state === 'FIN_WAIT_1') finAcked ? this.enterTimeWait() : (this.state = 'CLOSING')
      else if (this.state === 'FIN_WAIT_2') this.enterTimeWait()
      this.handlers.onRemoteClose?.(this)
    }

    this.pump()
  }

  _tick(now: number): void {
    if (this.state === 'TIME_WAIT') {
      if (now >= this.timeWaitDeadline) {
        this.engine._drop(this)
        this.state = 'CLOSED'
      }
      return
    }
    if (this.rtoDeadline !== 0 && now >= this.rtoDeadline) {
      if (this.retries >= MAX_RETRIES) {
        this.abort()
        this.handlers.onReset?.(this)
        return
      }
      this.retries += 1
      this.retransmit()
      this.armRto()
    }
    this.pump()
  }

  /* ---- send machinery ---- */

  /** Push out whatever data/FIN the window and state allow. */
  private pump(): void {
    if (this.state !== 'ESTABLISHED' && this.state !== 'CLOSE_WAIT' && this.state !== 'FIN_WAIT_1' && this.state !== 'CLOSING' && this.state !== 'LAST_ACK') {
      return
    }

    // Recompute from live state every iteration: a synchronous emit can
    // deliver the peer's ACK (which moves sndUna and the window) mid-loop.
    for (;;) {
      const inflight = seqDiff(this.sndNxt, this.sndUna)
      const finInFlight = this.finSent && inflight > 0 ? 1 : 0
      const unsent = this.sendTotal - (inflight - finInFlight)
      if (unsent <= 0 || this.finSent) break
      const windowRoom = seqDiff(this.peerAckLimit, this.sndNxt)
      if (windowRoom <= 0) break
      const len = Math.min(unsent, this.peerMss, windowRoom)
      const data = this.peekSendRange(inflight, len)
      const seq = this.sndNxt
      this.sndNxt = seqAdd(seq, len)
      this.armRtoIfIdle()
      this.emitSeg({ flags: TCP_ACK | TCP_PSH, seq, ack: this.rcvNxt, payload: data })
    }

    const inflightNow = seqDiff(this.sndNxt, this.sndUna)
    if (this.finQueued && !this.finSent && this.sendTotal - inflightNow <= 0) {
      const seq = this.sndNxt
      this.sndNxt = seqAdd(seq, 1)
      this.finSent = true
      if (this.state === 'ESTABLISHED') this.state = 'FIN_WAIT_1'
      else if (this.state === 'CLOSE_WAIT') this.state = 'LAST_ACK'
      this.armRtoIfIdle()
      this.emitSeg({ flags: TCP_FIN | TCP_ACK, seq, ack: this.rcvNxt })
    }
  }

  private retransmit(): void {
    const inflight = seqDiff(this.sndNxt, this.sndUna)
    if (this.state === 'SYN_SENT') {
      this.emitSeg({ flags: TCP_SYN, seq: seqAdd(this.sndNxt, -1), ack: 0, mss: MSS })
      return
    }
    if (this.state === 'SYN_RCVD') {
      this.emitSeg({ flags: TCP_SYN | TCP_ACK, seq: seqAdd(this.sndNxt, -1), ack: this.rcvNxt, mss: MSS })
      return
    }
    const finInFlight = this.finSent ? 1 : 0
    const dataInFlight = inflight - finInFlight
    if (dataInFlight > 0) {
      const len = Math.min(dataInFlight, this.peerMss)
      this.emitSeg({ flags: TCP_ACK | TCP_PSH, seq: this.sndUna, ack: this.rcvNxt, payload: this.peekSendRange(0, len) })
    } else if (finInFlight) {
      this.emitSeg({ flags: TCP_FIN | TCP_ACK, seq: seqAdd(this.sndNxt, -1), ack: this.rcvNxt })
    }
  }

  /** Bytes [offset, offset+len) of the send buffer, across chunk boundaries. */
  private peekSendRange(offset: number, len: number): Uint8Array {
    const out = new Uint8Array(len)
    let outPos = 0
    let pos = 0
    for (const chunk of this.sendChunks) {
      if (outPos === len) break
      const end = pos + chunk.length
      if (end > offset) {
        const from = Math.max(0, offset - pos)
        const take = Math.min(chunk.length - from, len - outPos)
        out.set(chunk.subarray(from, from + take), outPos)
        outPos += take
      }
      pos = end
    }
    return out
  }

  private consumeAcked(count: number): void {
    let left = count
    while (left > 0 && this.sendChunks.length > 0) {
      const head = this.sendChunks[0]
      if (head.length <= left) {
        left -= head.length
        this.sendChunks.shift()
      } else {
        this.sendChunks[0] = head.subarray(left)
        left = 0
      }
    }
    this.sendTotal -= count - left
  }

  private sendAck(): void {
    this.emitSeg({ flags: TCP_ACK, seq: this.sndNxt, ack: this.rcvNxt })
  }

  private emitSeg(fields: { flags: number; seq: number; ack: number; payload?: Uint8Array; mss?: number }): void {
    this.engine._emit({
      src: this.local,
      dst: this.remote,
      seg: {
        srcPort: this.local.port,
        dstPort: this.remote.port,
        seq: fields.seq,
        ack: fields.ack,
        flags: fields.flags,
        window: WINDOW,
        payload: fields.payload ?? new Uint8Array(0),
        mss: fields.mss,
      },
    })
  }

  private enterTimeWait(): void {
    this.state = 'TIME_WAIT'
    this.clearRto()
    this.timeWaitDeadline = this.engine._now() + TIME_WAIT_MS
    this.enterClosed(true)
  }

  /** Deliver onClose exactly once; `keep` leaves the socket in the table. */
  private enterClosed(fire: boolean): void {
    if (this.state !== 'TIME_WAIT') this.state = 'CLOSED'
    this.clearRto()
    this.sendChunks = []
    this.sendTotal = 0
    if (fire && !this.closed) {
      this.closed = true
      this.handlers.onClose?.(this)
    }
    if (!fire) this.closed = true
  }

  private armRto(): void {
    this.rtoDeadline = this.engine._now() + RTO_MS
  }

  private armRtoIfIdle(): void {
    if (this.rtoDeadline === 0) this.armRto()
  }

  private clearRto(): void {
    this.rtoDeadline = 0
    this.retries = 0
  }
}

interface Listener {
  port: number
  /** null: any local IP. */
  ip: number | null
  onAccept: (socket: TcpSocket) => void
}

/** Fields for the RST a caller should send for a segment nobody owns. */
export function rstReplyFor(seg: TcpSegment): TcpSegment {
  const hasAck = (seg.flags & TCP_ACK) !== 0
  const consumed = seg.payload.length + (seg.flags & TCP_SYN ? 1 : 0) + (seg.flags & TCP_FIN ? 1 : 0)
  return {
    srcPort: seg.dstPort,
    dstPort: seg.srcPort,
    seq: hasAck ? seg.ack : 0,
    ack: seqAdd(seg.seq, consumed),
    flags: hasAck ? TCP_RST : TCP_RST | TCP_ACK,
    window: 0,
    payload: new Uint8Array(0),
  }
}

export class TcpEngine {
  private hooks: TcpHooks
  private sockets = new Map<string, TcpSocket>()
  private listeners: Listener[] = []

  constructor(hooks: TcpHooks) {
    this.hooks = hooks
  }

  listen(match: { port: number; ip?: number | null }, onAccept: (socket: TcpSocket) => void): () => void {
    const listener: Listener = { port: match.port, ip: match.ip ?? null, onAccept }
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  connect(local: TcpEndpoint, remote: TcpEndpoint, handlers: TcpSocketHandlers = {}): TcpSocket {
    const socket = new TcpSocket(this, local, remote, 'SYN_SENT', this.hooks.randomSeq() >>> 0)
    socket.handlers = handlers
    this.sockets.set(connKey(local, remote), socket)
    socket._startConnect()
    return socket
  }

  /**
   * Feed one parsed TCP segment addressed to `dstIp`. Returns false when no
   * connection or listener wants it — the caller should answer with
   * rstReplyFor(seg).
   */
  onSegment(srcIp: number, dstIp: number, seg: TcpSegment): boolean {
    const local = { ip: dstIp, port: seg.dstPort }
    const remote = { ip: srcIp, port: seg.srcPort }
    const key = connKey(local, remote)
    const existing = this.sockets.get(key)
    if (existing) {
      existing._onSegment(seg)
      return true
    }

    if ((seg.flags & (TCP_SYN | TCP_ACK | TCP_RST)) === TCP_SYN) {
      const listener = this.listeners.find((l) => l.port === seg.dstPort && (l.ip === null || l.ip === dstIp))
      if (listener) {
        const socket = new TcpSocket(this, local, remote, 'SYN_RCVD', this.hooks.randomSeq() >>> 0)
        this.sockets.set(key, socket)
        listener.onAccept(socket) // attach handlers before any data can land
        socket._startAccept(seg.mss, seg.seq)
        return true
      }
    }
    // A stray RST needs no answer; anything else earns one.
    return (seg.flags & TCP_RST) !== 0
  }

  tick(): void {
    const now = this.hooks.now()
    for (const socket of [...this.sockets.values()]) socket._tick(now)
  }

  connectionCount(): number {
    return this.sockets.size
  }

  dispose(): void {
    for (const socket of [...this.sockets.values()]) socket.abort()
    this.sockets.clear()
    this.listeners = []
  }

  /* ---- socket plumbing ---- */
  _emit(out: TcpEmit): void {
    this.hooks.emit(out)
  }

  _now(): number {
    return this.hooks.now()
  }

  _drop(socket: TcpSocket): void {
    this.sockets.delete(connKey(socket.local, socket.remote))
  }
}

function connKey(local: TcpEndpoint, remote: TcpEndpoint): string {
  return `${local.ip}:${local.port}|${remote.ip}:${remote.port}`
}
