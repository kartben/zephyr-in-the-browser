/**
 * An RSP server that behaves the way OpenOCD's actually does, exposed as an
 * {@link RspTransport} — the no-hardware rig for Live board debugging, in the
 * spirit of virtio's fakeBridge: the full production client runs against a
 * scripted far end.
 *
 * The OpenOCD semantics that differ from QEMU's stub, all modeled here:
 *
 * - **Ack mode until QStartNoAckMode.** Every reply the server sends expects
 *   a `+` back; a next packet arriving unacked is tolerated (OpenOCD's IAR
 *   workaround) but counted in {@link FakeRspServer.missingAcks}. A `-`
 *   retransmits the last reply.
 * - **The session opens halted** by default (OpenOCD's gdb-attach event
 *   halts the target), but {@link FakeRspServerOptions.startRunning} models
 *   adopting a TUI-attached proxy whose target still runs — `?` then answers
 *   `S00`, OpenOCD's "no stop to report".
 * - **`O` console packets** can arrive at any time between replies.
 * - **vCont is optional.** With it off, `vCont?` and `vCont;c` return the
 *   empty unsupported reply and the target simply does not run — the trap
 *   the bare `c`/`s` fallback exists for.
 * - **`Z0` fails in flash** when a flash range is configured; `Z1` (hardware
 *   comparator) works there.
 * - Writes into flash fail with an error reply, like a real target.
 * - A `\x03` to a halted target is discarded in silence.
 */

import { bytesToHex, checksum, decodeStream, encodePacket } from '@/debug/gdb/rspCodec'
import type { RspTransport } from '@/debug/gdb/rspTransport'

export interface FakeRspServerOptions {
  /** Register-blob layout for `g`. Default 'arm' (Cortex-M, 17 × u32). */
  arch?: 'arm' | 'riscv32'
  /** Advertise and accept vCont. Default true. */
  supportsVCont?: boolean
  /** Addresses where `Z0` and memory writes fail. Default none. */
  flashRange?: { start: number; end: number } | null
  /** Target running at session open (adopted TUI proxy). Default false. */
  startRunning?: boolean
  /** Initial pc reported in `g`. */
  pc?: number
}

export class FakeRspServer {
  /** Every well-formed packet payload the client sent, in order. */
  readonly packets: string[] = []
  /** Replies the client moved past without acking while in ack mode. */
  missingAcks = 0
  /** `-` nacks received (each retransmits the last reply). */
  retransmits = 0
  /** `\x03` bytes that halted a running target. */
  breaks = 0
  /** `\x03` bytes discarded because the target was already halted. */
  discardedBreaks = 0
  running: boolean
  noAck = false
  pc: number
  readonly swBreakpoints = new Set<number>()
  readonly hwBreakpoints = new Set<number>()

  private readonly arch: 'arm' | 'riscv32'
  private readonly supportsVCont: boolean
  private readonly flashRange: { start: number; end: number } | null
  private out = ''
  private inBuf = ''
  private unacked = 0
  private lastReply = ''
  private lastStopPayload: string | null
  private onData: (() => void) | null = null
  private readonly memory = new Map<number, number>()

  constructor(opts: FakeRspServerOptions = {}) {
    this.arch = opts.arch ?? 'arm'
    this.supportsVCont = opts.supportsVCont ?? true
    this.flashRange = opts.flashRange ?? null
    this.running = opts.startRunning ?? false
    this.pc = opts.pc ?? 0x1000
    this.lastStopPayload = this.running ? null : 'T05thread:01;'
  }

  /** The byte pipe the production RspClient runs over. */
  transport(): RspTransport {
    return {
      drain: () => {
        const text = this.out
        this.out = ''
        const bytes = new Uint8Array(text.length)
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
        return bytes
      },
      send: (text) => this.feed(text),
      setOnData: (fn) => {
        this.onData = fn
      },
    }
  }

  /** Unsolicited target console output (`O` packet), any time. */
  emitConsole(text: string) {
    let hex = ''
    for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(2, '0')
    this.reply(`O${hex}`)
  }

  /** The running target hits a breakpoint (or is stopped by firmware fault). */
  hitBreakpoint(addr?: number) {
    if (!this.running) return
    this.running = false
    if (addr !== undefined) this.pc = addr
    this.lastStopPayload = 'T05thread:01;'
    this.reply(this.lastStopPayload)
  }

  private inFlash(addr: number): boolean {
    return this.flashRange !== null && addr >= this.flashRange.start && addr < this.flashRange.end
  }

  private push(text: string) {
    this.out += text
    this.onData?.()
  }

  private reply(payload: string) {
    const raw = encodePacket(payload)
    this.lastReply = raw
    if (!this.noAck) this.unacked++
    this.push(raw)
  }

  private feed(text: string) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (ch === '\x03' && !this.inBuf.includes('$')) {
        if (this.running) {
          this.running = false
          this.breaks++
          this.lastStopPayload = 'T02thread:01;'
          this.reply(this.lastStopPayload)
        } else {
          this.discardedBreaks++
        }
        continue
      }
      this.inBuf += ch
    }
    const { messages, rest } = decodeStream(this.inBuf)
    this.inBuf = rest
    for (const msg of messages) {
      if (msg.kind === 'ack') {
        this.unacked = Math.max(0, this.unacked - 1)
        continue
      }
      if (msg.kind === 'nack') {
        this.retransmits++
        this.push(this.lastReply)
        continue
      }
      if (msg.kind !== 'packet') continue
      // IAR workaround: a new packet implicitly abandons pending acks.
      if (!this.noAck && this.unacked > 0) {
        this.missingAcks += this.unacked
        this.unacked = 0
      }
      if (!this.noAck) this.push('+')
      this.handle(msg.payload)
    }
  }

  private handle(payload: string) {
    this.packets.push(payload)
    if (payload.startsWith('qSupported')) {
      this.reply('PacketSize=4000;QStartNoAckMode+;swbreak+;hwbreak+')
      return
    }
    if (payload === 'QStartNoAckMode') {
      this.reply('OK')
      this.noAck = true
      return
    }
    if (payload === '?') {
      // OpenOCD answers signal 0 when there is no stop to report.
      this.reply(this.running ? 'S00' : (this.lastStopPayload ?? 'T05thread:01;'))
      return
    }
    if (payload === 'g') {
      this.reply(this.registersHex())
      return
    }
    if (payload === 'vCont?') {
      this.reply(this.supportsVCont ? 'vCont;c;C;s;S' : '')
      return
    }
    if (payload === 'vCont;c' || payload === 'c') {
      if (payload === 'vCont;c' && !this.supportsVCont) {
        // Unsupported: empty reply, and the target does not run.
        this.reply('')
        return
      }
      this.running = true
      this.lastStopPayload = null
      return
    }
    if (payload === 'vCont;s' || payload === 's') {
      if (payload === 'vCont;s' && !this.supportsVCont) {
        this.reply('')
        return
      }
      this.pc += this.arch === 'arm' ? 2 : 4
      this.lastStopPayload = 'T05thread:01;'
      this.reply(this.lastStopPayload)
      return
    }
    if (payload.startsWith('m')) {
      const [addrHex, lenHex] = payload.slice(1).split(',')
      const addr = Number.parseInt(addrHex ?? '0', 16)
      const len = Number.parseInt(lenHex ?? '0', 16)
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) bytes[i] = this.memory.get(addr + i) ?? 0
      this.reply(bytesToHex(bytes))
      return
    }
    if (payload.startsWith('M')) {
      const [head, dataHex] = payload.slice(1).split(':')
      const [addrHex] = (head ?? '').split(',')
      const addr = Number.parseInt(addrHex ?? '0', 16)
      if (this.inFlash(addr)) {
        this.reply('E0e')
        return
      }
      for (let i = 0; i < (dataHex ?? '').length / 2; i++) {
        this.memory.set(addr + i, Number.parseInt(dataHex!.slice(i * 2, i * 2 + 2), 16))
      }
      this.reply('OK')
      return
    }
    if (payload.startsWith('Z0,') || payload.startsWith('z0,')) {
      const addr = Number.parseInt(payload.slice(3).split(',')[0] ?? '0', 16)
      if (payload.startsWith('Z0')) {
        if (this.inFlash(addr)) {
          this.reply('E01')
          return
        }
        this.swBreakpoints.add(addr)
      } else {
        this.swBreakpoints.delete(addr)
      }
      this.reply('OK')
      return
    }
    if (payload.startsWith('Z1,') || payload.startsWith('z1,')) {
      const addr = Number.parseInt(payload.slice(3).split(',')[0] ?? '0', 16)
      if (payload.startsWith('Z1')) this.hwBreakpoints.add(addr)
      else this.hwBreakpoints.delete(addr)
      this.reply('OK')
      return
    }
    this.reply('')
  }

  private registersHex(): string {
    const regs = this.arch === 'arm' ? 17 : 33
    const pcIndex = this.arch === 'arm' ? 15 : 32
    let out = ''
    for (let i = 0; i < regs; i++) {
      const value = i === pcIndex ? this.pc : 0
      const bytes = new Uint8Array(4)
      new DataView(bytes.buffer).setUint32(0, value >>> 0, true)
      out += bytesToHex(bytes)
    }
    return out
  }
}

/** Corrupt a valid `$…#cs` on purpose (checksum off by one) for nack tests. */
export function corruptPacket(payload: string): string {
  const good = encodePacket(payload)
  const cs = ((Number.parseInt(checksum(payload), 16) + 1) & 0xff).toString(16).padStart(2, '0')
  return good.slice(0, -2) + cs
}
