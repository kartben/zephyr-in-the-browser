/**
 * RSP over the desktop bridge: CH_GDB frames in, CH_GDB frames out. The io
 * is injected so this stays free of the probe/client singleton (no import
 * cycle, and tests script it); liveDebug wires the real client in.
 */

import type { RspTransport } from '@/debug/gdb/rspTransport'

export interface BridgeGdbIo {
  /** Frame RSP bytes onto CH_GDB. False when the socket is down (dropped). */
  sendGdbBytes(bytes: Uint8Array): boolean
  /** Register (or clear) the CH_GDB frame sink. */
  setGdbHandler(handler: ((payload: Uint8Array) => void) | null): void
}

/**
 * Creating the transport claims the channel: the handler is replaced, so
 * frames a previous session buffered die with its transport, and this one
 * starts empty. Bytes that arrive before the session's first poll simply
 * wait in the buffer — the codec skips anything that is not a packet.
 */
export function bridgeRspTransport(io: BridgeGdbIo): RspTransport {
  let chunks: Uint8Array[] = []
  let size = 0
  let onData: (() => void) | null = null

  io.setGdbHandler((payload) => {
    chunks.push(payload.slice())
    size += payload.length
    onData?.()
  })

  return {
    drain: () => {
      if (chunks.length === 0) return new Uint8Array(0)
      const out = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      chunks = []
      size = 0
      return out
    },
    send: (text) => {
      // Same byte-for-char mapping feedBytes uses; RSP is ASCII on the wire.
      const bytes = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
      io.sendGdbBytes(bytes)
    },
    setOnData: (fn) => {
      onData = fn
    },
    close: () => {
      io.setGdbHandler(null)
      chunks = []
      size = 0
      onData = null
    },
  }
}
