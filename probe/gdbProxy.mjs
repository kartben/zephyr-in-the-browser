/**
 * Thin TCP ↔ byte-stream proxy for a local GDB server (OpenOCD, J-Link,
 * pyOCD, Espressif OpenOCD, …). The daemon stays up when the GDB server
 * restarts; callers re-attach.
 */

import { connect } from 'node:net'

/**
 * @param {{
 *   host: string,
 *   port: number,
 *   onData: (chunk: Buffer) => void,
 *   onError: (err: Error) => void,
 *   onClose: () => void,
 *   connectImpl?: typeof connect,
 * }} opts
 */
export function openGdbProxy(opts) {
  const { host, port, onData, onError, onClose, connectImpl = connect } = opts
  let closed = false
  const sock = connectImpl(port, host)

  const close = () => {
    if (closed) return
    closed = true
    sock.destroy()
  }

  sock.on('connect', () => {
    /* ready */
  })
  sock.on('data', (chunk) => {
    if (!closed && chunk?.length) onData(Buffer.from(chunk))
  })
  sock.on('error', (err) => {
    if (closed) return
    onError(err instanceof Error ? err : new Error(String(err)))
  })
  sock.on('close', () => {
    if (closed) return
    closed = true
    onClose()
  })

  return {
    host,
    port,
    close,
    /** @param {Buffer|Uint8Array|string} data */
    write(data) {
      if (closed || sock.destroyed) return false
      sock.write(data)
      return true
    },
  }
}
