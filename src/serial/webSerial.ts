/**
 * The slice of the Web Serial API (navigator.serial) the uart1 pipe uses.
 *
 * TypeScript's DOM library does not declare Web Serial, so the shapes are
 * spelled out here rather than pulled in as a dependency. Chrome and Edge on
 * the desktop, Chrome on Android and Firefox 151+ have it; Safari does not.
 */

export interface SerialPortInfo {
  usbVendorId?: number
  usbProductId?: number
}

export interface SerialOpenOptions {
  baudRate: number
}

export interface SerialPortLike extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  getInfo(): SerialPortInfo
  open(options: SerialOpenOptions): Promise<void>
  close(): Promise<void>
}

export interface SerialLike extends EventTarget {
  getPorts(): Promise<SerialPortLike[]>
  requestPort(): Promise<SerialPortLike>
}

/** navigator.serial, or null where the browser has no Web Serial. */
export function getSerial(): SerialLike | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { serial?: SerialLike }).serial ?? null
}

export function serialSupported(): boolean {
  return getSerial() !== null
}

/** Rates a USB-serial adapter offers in practice, slowest first. */
export const BAUD_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000,
] as const

export const DEFAULT_BAUD_RATE = 115200

const hex4 = (n: number) => n.toString(16).padStart(4, '0')

/** `0403:6001`, the identity a saved pipe matches on; null without USB IDs. */
export function portIds(vid: number | undefined, pid: number | undefined): string | null {
  return vid === undefined || pid === undefined ? null : `${hex4(vid)}:${hex4(pid)}`
}

/*
 * Web Serial reports USB vendor and product IDs and nothing else: no product
 * string, no serial number. These are the adapters and probes people actually
 * plug into a Zephyr board, so the dock can name them instead of printing hex.
 */
const PRODUCTS: Record<string, string> = {
  '0403:6001': 'FTDI FT232R',
  '0403:6010': 'FTDI FT2232',
  '0403:6014': 'FTDI FT232H',
  '0403:6015': 'FTDI FT231X',
  '10c4:ea60': 'Silicon Labs CP210x',
  '1a86:7523': 'WCH CH340',
  '1a86:55d4': 'WCH CH9102',
  '067b:2303': 'Prolific PL2303',
  '0483:374b': 'ST-Link V2-1',
  '0483:374e': 'ST-Link V3',
  '0483:374f': 'ST-Link V3',
  '0483:3753': 'ST-Link V3',
  '303a:1001': 'Espressif USB JTAG/serial',
  '2e8a:000c': 'Raspberry Pi Debug Probe',
  '2e8a:000a': 'Raspberry Pi Pico',
  '1546:01a7': 'u-blox 7 GNSS',
  '1546:01a8': 'u-blox 8 GNSS',
  '1546:01a9': 'u-blox 9 GNSS',
  '0d28:0204': 'Arm DAPLink',
}

const VENDORS: Record<number, string> = {
  0x0403: 'FTDI',
  0x10c4: 'Silicon Labs',
  0x1a86: 'WCH',
  0x067b: 'Prolific',
  0x0483: 'STMicroelectronics',
  0x1366: 'SEGGER J-Link',
  0x303a: 'Espressif',
  0x2e8a: 'Raspberry Pi',
  0x1546: 'u-blox',
  0x1915: 'Nordic Semiconductor',
  0x0d28: 'Arm DAPLink',
  0x2341: 'Arduino',
  0x239a: 'Adafruit',
  0x2fe3: 'Zephyr USB device',
}

/** A name for a port the user can recognise: `FTDI FT232R (0403:6001)`. */
export function describeIds(vid: number | undefined, pid: number | undefined): string {
  const ids = portIds(vid, pid)
  if (!ids) return 'Serial port'
  const name = PRODUCTS[ids] ?? (vid !== undefined ? VENDORS[vid] : undefined) ?? 'USB serial'
  return `${name} (${ids})`
}

export function describePort(info: SerialPortInfo): string {
  return describeIds(info.usbVendorId, info.usbProductId)
}

/** A port the user already granted, plugged in now, with these USB IDs. */
export async function findGrantedPort(vid: number, pid: number): Promise<SerialPortLike | null> {
  const serial = getSerial()
  if (!serial) return null
  const ports = await serial.getPorts()
  return (
    ports.find((p) => {
      const info = p.getInfo()
      return info.usbVendorId === vid && info.usbProductId === pid
    }) ?? null
  )
}

/** Why open() failed, in words that say what to do about it. */
export function openErrorMessage(err: unknown, label: string): string {
  const name = err instanceof Error || err instanceof DOMException ? err.name : ''
  if (name === 'TimeoutError') {
    // The bridge docs' "wedged VCP": open() parks in the kernel until a replug.
    return `Timed out opening ${label}. Unplug it and plug it back in.`
  }
  if (name === 'InvalidStateError') return `${label} is already open in this page.`
  if (name === 'NetworkError') {
    return `Couldn't open ${label}. Another app may have it open, such as the desktop bridge or a serial terminal.`
  }
  return err instanceof Error && err.message ? err.message : `Couldn't open ${label}.`
}
