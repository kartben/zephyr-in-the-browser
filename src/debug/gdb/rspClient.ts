/**
 * Minimal GDB RSP client over a byte pipe ({@link RspTransport}: the browser
 * gdb chardev, or the desktop bridge's CH_GDB channel).
 *
 * Supports: qSupported / no-ack, halt (`\x03` / `?`), continue, step, `g`,
 * software breakpoints (`Z0`/`z0`), memory read (`m`), and memory write (`M`).
 *
 * ## Never write to a running stub
 *
 * QEMU's gdbstub does not queue packets that arrive while the vCPU is running.
 * `gdb_read_byte()` short-circuits on `runstate_is_running()`: *any* byte stops
 * the machine, and only a bare `0x03` also sets `allow_stop_reply`. So a packet
 * posted a moment after a resume — a stale `m` from a thread walk, a second
 * `vCont;c` from a double-click — halts the guest and reports nothing. The page
 * goes on showing "running" over a machine that will never retire another
 * instruction, and every later `0x03` is read as garbage by the stopped stub
 * and answered with silence.
 *
 * That is why {@link running} gates every write. It is not display state; it is
 * the precondition for touching the pipe at all.
 */

import type { RspTransport } from '@/debug/gdb/rspTransport'
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

/** Stand-in for a stop we know happened but never got a reply packet for. */
const UNKNOWN_STOP: StopInfo = { kind: 'signal', signal: 5, raw: 'S05' }

export class RspClient {
  private buffer = ''
  private noAck = false
  private waiting: Waiting | null = null
  private onStop: ((info: StopInfo) => void) | null = null
  /**
   * Whether the vCPU is executing. Gates every write — see the module note.
   *
   * Starts false: opening the gdb chardev makes QEMU `vm_stop()` before the
   * handshake, so the stub is halted by the time {@link start} runs.
   */
  private running = false
  /** The stop we are parked at, so a redundant halt can answer without a write. */
  private lastStop: StopInfo | null = null
  /** In-flight halt, shared by every caller that asks while it is pending. */
  private pendingInterrupt: Promise<StopInfo> | null = null

  constructor(private readonly transport: RspTransport) {}

  /** Whether the stub last told us the machine is executing. */
  isRunning(): boolean {
    return this.running
  }

  setStopHandler(fn: ((info: StopInfo) => void) | null) {
    this.onStop = fn
  }

  /** Pull bytes from the transport and dispatch. */
  poll() {
    const chunk = this.transport.drain()
    if (chunk.length === 0) return
    for (let i = 0; i < chunk.length; i++) this.buffer += String.fromCharCode(chunk[i]!)
    const { messages, rest } = decodeStream(this.buffer)
    this.buffer = rest
    for (const msg of messages) {
      if (msg.kind === 'ack' || msg.kind === 'nack') continue
      if (msg.kind !== 'packet') continue
      const payload = msg.payload
      const stop =
        payload.startsWith('T') || payload.startsWith('S') ? parseStop(payload) : null
      // A stop reply is the one authoritative statement about the run state.
      if (stop) {
        this.running = false
        this.lastStop = stop
      }
      if (this.waiting) {
        // Only a stop reply can answer a halt. Console output (`O…`) is a
        // notification, and anything else here is the late answer to a request
        // that was superseded — letting either resolve the waiter reported a
        // failed pause over a machine that had in fact stopped.
        if (this.waiting.wantStop && !stop) continue
        const w = this.waiting
        this.waiting = null
        clearTimeout(w.timer)
        w.resolve(payload)
        // Whoever awaited the stop runs its own follow-up. Firing the handler
        // too meant every Pause did the register/thread/stack walk twice.
        if (stop && !w.wantStop) this.onStop?.(stop)
        continue
      }
      if (stop) this.onStop?.(stop)
    }
  }

  private sendRaw(text: string) {
    this.transport.send(text)
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
      // The queue can outlive the pause that filled it: a thread walk keeps
      // asking for the next node long after the user hit Resume. Posting that
      // to a running stub freezes the guest silently, so drop it instead.
      if (this.running) return Promise.reject(new Error('RSP request while running'))
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
    if (why.startsWith('T') || why.startsWith('S')) {
      this.lastStop = parseStop(why)
      return this.lastStop
    }
    this.running = true
    return null
  }

  /**
   * Halt the machine.
   *
   * Three ways this used to wedge, all of them now handled here rather than
   * left to the caller:
   *
   * - **Already stopped.** A stopped stub reads `0x03` as garbage and never
   *   answers, so the wait timed out and the caller concluded the pause had
   *   failed — over a machine that was halted the whole time.
   * - **Two clicks in a row.** The second call cancelled the first one's wait
   *   and posted another `0x03`; the machine had already stopped on the first,
   *   so the second was garbage and nobody was left waiting for the one reply
   *   that did come back.
   * - **A lost reply.** A running stub *always* answers `0x03`, so silence
   *   means the machine was not running. Adopting that is what turns a stuck
   *   pause into a recoverable one — believing the timeout instead left
   *   `paused` false, and Resume then refused to send `vCont;c`.
   */
  async interrupt(): Promise<StopInfo> {
    if (this.pendingInterrupt) return this.pendingInterrupt
    if (!this.running) return this.lastStop ?? UNKNOWN_STOP

    const pending = (async () => {
      try {
        // Break must reach the stub even if a prior request is wedged.
        this.epoch++
        if (this.waiting) {
          clearTimeout(this.waiting.timer)
          this.waiting.reject(new Error('superseded by interrupt'))
          this.waiting = null
        }
        this.sendRaw('\x03')
        try {
          return await this.waitStop()
        } catch {
          this.running = false
          return this.lastStop ?? UNKNOWN_STOP
        }
      } finally {
        this.pendingInterrupt = null
      }
    })()
    this.pendingInterrupt = pending
    return pending
  }

  /**
   * Let the machine go. Idempotent: a second `vCont;c` would reach a stub that
   * is already running, and QEMU stops the machine on the stray byte without
   * sending a stop reply — the silent freeze this class exists to prevent.
   */
  async continue(): Promise<void> {
    if (this.running) return
    // Fire-and-forget until a later stop; do not block the UI on continue.
    this.epoch++
    if (this.waiting) {
      clearTimeout(this.waiting.timer)
      this.waiting.reject(new Error('superseded'))
      this.waiting = null
    }
    this.running = true
    this.lastStop = null
    this.sendPacket('vCont;c')
  }

  async step(): Promise<StopInfo> {
    if (this.running) throw new Error('cannot step a running machine')
    // The vCPU really does run for the length of the instruction, so hold the
    // gate shut until the stop lands — and reopen it even if the reply is lost,
    // since a single step always ends halted.
    this.running = true
    this.sendPacket('vCont;s')
    try {
      return await this.waitStop()
    } finally {
      this.running = false
    }
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
