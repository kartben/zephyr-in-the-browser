/**
 * Serial-port discovery and CTF streaming.
 *
 * Hot-plug friendly: listPorts() is cheap and meant to be polled. Opening a
 * path that later disappears surfaces as an error/close; the daemon stays up.
 */

import { SerialPort } from 'serialport'

/** @typedef {{ path: string, manufacturer: string | null, serialNumber: string | null, vendorId: string | null, productId: string | null, friendlyName: string }} PortInfo */

/**
 * @param {typeof SerialPort} [SerialPortImpl]
 * @returns {Promise<PortInfo[]>}
 */
export async function listPorts(SerialPortImpl = SerialPort) {
  const ports = await SerialPortImpl.list()
  return ports
    .map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer ?? null,
      serialNumber: p.serialNumber ?? null,
      vendorId: p.vendorId ?? null,
      productId: p.productId ?? null,
      friendlyName: friendlyName(p),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function friendlyName(p) {
  const bits = [p.manufacturer, p.serialNumber].filter(Boolean)
  if (bits.length) return bits.join(' · ')
  if (p.vendorId && p.productId) return `${p.vendorId}:${p.productId}`
  return 'serial port'
}

/**
 * Open a serial port and stream bytes. Sends Zephyr's tracing host command
 * `enable\\r` once open so UART-CTF builds that wait for the host start
 * streaming (harmless when tracing is already on).
 *
 * @param {{
 *   path: string,
 *   baudRate?: number,
 *   onData: (chunk: Buffer) => void,
 *   onError: (err: Error) => void,
 *   onClose: () => void,
 *   SerialPortImpl?: typeof SerialPort,
 *   sendEnable?: boolean,
 * }} opts
 */
export function openSerialStream(opts) {
  const {
    path,
    baudRate = 115200,
    onData,
    onError,
    onClose,
    SerialPortImpl = SerialPort,
    sendEnable = true,
  } = opts

  const port = new SerialPortImpl({ path, baudRate, autoOpen: false })
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    try {
      if (port.isOpen) port.close(() => {})
      else port.destroy?.()
    } catch {
      /* already gone */
    }
  }

  port.on('data', (chunk) => {
    if (!closed && chunk?.length) onData(Buffer.from(chunk))
  })
  port.on('error', (err) => {
    if (closed) return
    onError(err instanceof Error ? err : new Error(String(err)))
  })
  port.on('close', () => {
    if (closed) return
    closed = true
    onClose()
  })

  port.open((err) => {
    if (err) {
      onError(err instanceof Error ? err : new Error(String(err)))
      return
    }
    if (sendEnable) {
      try {
        port.write(Buffer.from('enable\r'))
      } catch {
        /* best-effort */
      }
    }
  })

  return {
    path,
    baudRate,
    close,
    /** @param {Buffer|Uint8Array|string} data */
    write(data) {
      if (closed || !port.isOpen) return false
      port.write(data)
      return true
    },
  }
}
