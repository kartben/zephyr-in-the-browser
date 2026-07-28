/**
 * Minimal GDB RSP client over a byte pipe (browser gdb chardev).
 *
 * Supports: qSupported / no-ack, halt (`\x03` / `?`), continue, step, `g`,
 * software breakpoints (`Z0`/`z0`), memory read (`m`), and memory write (`M`).
 */

import { drainBytes, feedBytes, type ChardevExports } from '@/debug/browserChardev'
import { bytesToHex, decodeStream, encodePacket, hexToBytes } from '@/debug/gdb/rspCodec'

const DEFAULT_TIMEOUT_MS = 3000

export type StopInfo = { kind: 'signal' | 'watch' | 'exit'; signal?: number; raw: string }

type Waiting = {
  /** Resolve when the next non-ack packet arrives (or a stop reply if wantStop). */
  resolve: (payload: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  wantStop: boolean
}

function isStopReply(payload: string): boolean {
  return (
    payload.startsWith('T') ||
    payload.startsWith('S') ||
    payload.startsWith('W') ||
    payload.startsWith('X') ||
    payload === 'OK' // unlikely as stop, but harmless
  )
}

export class RspClient {
  private buffer = ''
  private noAck = false
  private waiting: Waiting | null = null
  private onStop: ((info: StopInfo) => void) | null = null

  constructor(private readonly ch: ChardevExports) {}

  setStopHandler(fn: ((info: StopInfo) => void) | null) {
    this.onStop = fn
  }

  /** Pull bytes from the ring and dispatch. */
  poll() {
    const chunk = drainBytes(this.ch)
    if (chunk.length === 0) return
    for (let i = 0; i < chunk.length; i++) this.buffer += String.fromCharCode(chunk[i]!)
    const { messages, rest } = decodeStream(this.buffer)
    this.buffer = rest
    for (const msg of messages) {
      if (msg.kind === 'ack' || msg.kind === 'nack') continue
      if (msg.kind !== 'packet') continue
      const payload = msg.payload
      if (this.waiting) {
        if (this.waiting.wantStop && !isStopReply(payload) && !payload.startsWith('T') && !payload.startsWith('S')) {
          // Notification? Ignore until stop.
          if (payload.startsWith('O')) continue // console output
        }
        const w = this.waiting
        this.waiting = null
        clearTimeout(w.timer)
        w.resolve(payload)
        if (isStopReply(payload) && (payload.startsWith('T') || payload.startsWith('S'))) {
          this.onStop?.(parseStop(payload))
        }
        continue
      }
      if (payload.startsWith('T') || payload.startsWith('S')) {
        this.onStop?.(parseStop(payload))
      }
    }
  }

  private sendRaw(text: string) {
    feedBytes(this.ch, text)
  }

  private sendPacket(payload: string) {
    this.sendRaw(encodePacket(payload))
  }

  /**
   * Serialize RSP round-trips. The stub only answers one packet at a time;
   * callers (regs / threads / Mem pane) otherwise race and lose with
   * "already in flight".
   */
  private tail: Promise<unknown> = Promise.resolve()
  /** Bumped by interrupt/continue so queued work can bail. */
  private epoch = 0

  private request(payload: string, opts?: { wantStop?: boolean; timeoutMs?: number }): Promise<string> {
    const epoch = this.epoch
    const run = () => {
      if (epoch !== this.epoch) return Promise.reject(new Error('RSP request superseded'))
      return this.requestExclusive(payload, opts)
    }
    const next = this.tail.then(run, run)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private requestExclusive(
    payload: string,
    opts?: { wantStop?: boolean; timeoutMs?: number },
  ): Promise<string> {
    if (this.waiting) {
      return Promise.reject(new Error('RSP request already in flight'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null
        reject(new Error(`RSP timeout waiting for ${payload.slice(0, 24)}`))
      }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.waiting = { resolve, reject, timer, wantStop: opts?.wantStop ?? false }
      this.sendPacket(payload)
    })
  }

  /** Handshake: enable no-ack when offered, then query halt reason. */
  async start(): Promise<StopInfo | null> {
    this.poll()
    const supported = await this.request('qSupported:multiprocess+;swbreak+;hwbreak+;qRelocateMemory+;vContSupported+;QStartNoAckMode+')
    if (supported.includes('QStartNoAckMode+')) {
      const ack = await this.request('QStartNoAckMode')
      if (ack === 'OK') this.noAck = true
    }
    void this.noAck
    const why = await this.request('?')
    if (why.startsWith('T') || why.startsWith('S')) return parseStop(why)
    return null
  }

  async interrupt(): Promise<StopInfo> {
    // Break must reach the stub even if a prior request is wedged.
    this.epoch++
    if (this.waiting) {
      clearTimeout(this.waiting.timer)
      this.waiting.reject(new Error('superseded by interrupt'))
      this.waiting = null
    }
    this.sendRaw('\x03')
    return this.waitStop()
  }

  async continue(): Promise<void> {
    // Fire-and-forget until a later stop; do not block the UI on continue.
    this.epoch++
    if (this.waiting) {
      clearTimeout(this.waiting.timer)
      this.waiting.reject(new Error('superseded'))
      this.waiting = null
    }
    this.sendPacket('vCont;c')
  }

  async step(): Promise<StopInfo> {
    this.sendPacket('vCont;s')
    return this.waitStop()
  }

  async readRegisters(): Promise<string> {
    return this.request('g')
  }

  async readMemory(addr: number, length: number): Promise<Uint8Array> {
    const hex = await this.request(`m${addr.toString(16)},${length.toString(16)}`)
    if (hex.startsWith('E')) throw new Error(`memory read error: ${hex}`)
    return hexToBytes(hex)
  }

  /** Write bytes via the hex `M` packet (`Maddr,length:XX…`). */
  async writeMemory(addr: number, data: Uint8Array): Promise<void> {
    if (data.length === 0) return
    const reply = await this.request(
      `M${addr.toString(16)},${data.length.toString(16)}:${bytesToHex(data)}`,
    )
    if (reply !== 'OK') throw new Error(`memory write error: ${reply}`)
  }

  async insertSwBreakpoint(addr: number, kind: number): Promise<boolean> {
    const r = await this.request(`Z0,${addr.toString(16)},${kind.toString(16)}`)
    return r === 'OK'
  }

  async removeSwBreakpoint(addr: number, kind: number): Promise<boolean> {
    const r = await this.request(`z0,${addr.toString(16)},${kind.toString(16)}`)
    return r === 'OK'
  }

  private waitStop(): Promise<StopInfo> {
    return new Promise((resolve, reject) => {
      if (this.waiting) {
        reject(new Error('RSP request already in flight'))
        return
      }
      const timer = setTimeout(() => {
        this.waiting = null
        reject(new Error('RSP timeout waiting for stop'))
      }, DEFAULT_TIMEOUT_MS)
      this.waiting = {
        wantStop: true,
        timer,
        reject,
        resolve: (payload) => {
          if (payload.startsWith('T') || payload.startsWith('S')) resolve(parseStop(payload))
          else reject(new Error(`unexpected RSP reply: ${payload}`))
        },
      }
    })
  }
}

function parseStop(payload: string): StopInfo {
  if (payload.startsWith('S') || payload.startsWith('T')) {
    const signal = Number.parseInt(payload.slice(1, 3), 16)
    return { kind: 'signal', signal: Number.isFinite(signal) ? signal : undefined, raw: payload }
  }
  if (payload.startsWith('W')) return { kind: 'exit', raw: payload }
  return { kind: 'signal', raw: payload }
}
