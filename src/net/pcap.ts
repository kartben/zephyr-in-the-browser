/** Classic pcap (LINKTYPE_ETHERNET) writer for the capture download. */

import { concat, viewOf } from './bytes'

export interface PcapEntry {
  /** Epoch milliseconds. */
  ts: number
  data: Uint8Array
}

export function writePcap(entries: ReadonlyArray<PcapEntry>): Uint8Array {
  const header = new Uint8Array(24)
  const view = viewOf(header)
  view.setUint32(0, 0xa1b2c3d4) // magic, microsecond timestamps
  view.setUint16(4, 2) // major
  view.setUint16(6, 4) // minor
  view.setUint32(16, 65535) // snaplen
  view.setUint32(20, 1) // LINKTYPE_ETHERNET

  const records = entries.map((e) => {
    const rec = new Uint8Array(16 + e.data.length)
    const rv = viewOf(rec)
    rv.setUint32(0, Math.floor(e.ts / 1000))
    rv.setUint32(4, Math.floor((e.ts % 1000) * 1000))
    rv.setUint32(8, e.data.length)
    rv.setUint32(12, e.data.length)
    rec.set(e.data, 16)
    return rec
  })
  return concat(header, ...records)
}
