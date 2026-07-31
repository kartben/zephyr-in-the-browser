/**
 * The byte pipe an RSP session runs over. RspClient predates having more than
 * one — the QEMU browser chardev *was* the pipe — so this interface is shaped
 * exactly like that ring: a synchronous drain the 20 ms poll pulls from, plus
 * a raw send. The desktop bridge's CH_GDB channel implements the same shape
 * for Live board sessions.
 */

import { drainBytes, feedBytes, type ChardevExports } from '@/debug/browserChardev'

export interface RspTransport {
  /** Everything received since the last call. */
  drain(): Uint8Array
  /** Queue raw RSP bytes toward the stub. */
  send(text: string): void
  /**
   * Optional wake for push transports: called when bytes are waiting, so the
   * session owner can poll before the next timer tick. Pull transports (the
   * chardev ring) simply do not implement it.
   */
  setOnData?(fn: (() => void) | null): void
  close?(): void
}

/** The QEMU browser-chardev ring as an RspTransport. */
export function chardevRspTransport(ch: ChardevExports): RspTransport {
  return {
    drain: () => drainBytes(ch),
    send: (text) => feedBytes(ch, text),
  }
}
