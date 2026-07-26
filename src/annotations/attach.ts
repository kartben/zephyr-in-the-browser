/**
 * The seam between xterm and the walkthrough.
 *
 * Everything interesting is in protocol.ts and store.ts, which are pure and
 * covered by vitest; this is the two lines that cannot be, because they need a
 * live terminal.
 */

import type { Terminal } from '@xterm/xterm'
import { decodeRecord, OSC_IDENT } from '@/annotations/protocol'
import { handleRecord } from '@/annotations/store'

/**
 * Listen for annotation records on a terminal. Returns a detach function.
 *
 * The handler returns true whatever it makes of the payload: a record we
 * cannot parse is still ours, and letting it through would paint escape
 * gibberish across the sample's output. Consuming it silently is the same
 * thing a terminal that has never heard of OSC 9700 does anyway.
 */
export function attachAnnotations(xterm: Terminal): () => void {
  const handler = xterm.parser.registerOscHandler(OSC_IDENT, (payload) => {
    const record = decodeRecord(payload)
    if (record !== null) handleRecord(record)
    return true
  })
  return () => handler.dispose()
}
