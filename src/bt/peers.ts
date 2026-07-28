/**
 * In-page Bluetooth peer presets on the shared Bumble LocalLink.
 *
 * Same idea as {@link ../can/nodes.ts}: each entry is a counterpart a packaged
 * sample can talk to, not a full Hive app. The page *is* the air — no server.
 *
 * Live knobs (inspector) are declared here so the dock can render sensor-like
 * controls without promoting peers to topology rows — see
 * docs/bluetooth-peer-ui-spec.md.
 */

export interface BtPeerType {
  id: string
  label: string
  /** Short roster subtitle while the peer is up (fallback before live params). */
  summary: string
}

export type BtPeerParamValue = string | number | boolean

export interface BtPeerParams {
  [key: string]: BtPeerParamValue
}

export const BT_PEER_TYPES: BtPeerType[] = [
  {
    id: 'hrm',
    label: 'Heart rate monitor',
    summary: 'Advertises GATT Heart Rate (0x180D)',
  },
  {
    id: 'advertiser',
    label: 'Advertiser',
    summary: 'Connectable LE advertisement',
  },
  {
    id: 'scanner',
    label: 'Scanner',
    summary: 'Passive LE scan',
  },
]

export function peerType(id: string): BtPeerType | undefined {
  return BT_PEER_TYPES.find((t) => t.id === id)
}

/** Default live params when a peer is added (mock + until Bumble apply lands). */
export function defaultPeerParams(typeId: string, name: string): BtPeerParams {
  switch (typeId) {
    case 'hrm':
      return { bpm: 72, advertising: true }
    case 'advertiser':
      return { localName: name, advertising: true, connectable: true }
    case 'scanner':
      return { scanning: true, active: false, advCount: 0 }
    default:
      return {}
  }
}

/** One-line roster subtitle derived from live params. */
export function peerDetail(typeId: string, params: BtPeerParams | undefined, fallback: string): string {
  if (!params) return fallback
  if (typeId === 'hrm') {
    const bpm = Number(params.bpm ?? 72)
    return params.advertising ? `${bpm} BPM · advertising` : `${bpm} BPM · stopped`
  }
  if (typeId === 'advertiser') {
    if (!params.advertising) return 'stopped'
    return params.connectable ? 'connectable · advertising' : 'non-connectable · advertising'
  }
  if (typeId === 'scanner') {
    const n = Number(params.advCount ?? 0)
    if (!params.scanning) return `${n} adv reports · paused`
    return params.active ? `${n} adv reports · active` : `${n} adv reports`
  }
  return fallback
}
