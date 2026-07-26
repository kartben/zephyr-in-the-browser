import type { Terminal } from '@xterm/xterm'
import { decodeRecord, OSC_IDENT } from '@/annotations/protocol'
import { handleRecord } from '@/annotations/store'

export function attachAnnotations(xterm: Terminal): () => void {
  const handler = xterm.parser.registerOscHandler(OSC_IDENT, (payload) => {
    const record = decodeRecord(payload)
    if (record !== null) handleRecord(record)
    // Consume even malformed OSC 9700 payloads so escape text never paints.
    return true
  })
  return () => handler.dispose()
}
