import { describe, expect, it } from 'vitest'
import { BT_PEER_TYPES, defaultPeerParams, peerDetail, peerType } from '@/bt/peers'

describe('BT_PEER_TYPES', () => {
  it('lists the in-page LocalLink presets', () => {
    expect(BT_PEER_TYPES.map((t) => t.id)).toEqual([
      'hrm',
      'advertiser',
      'scanner',
      'speaker',
    ])
  })

  it('resolves presets by id', () => {
    expect(peerType('hrm')?.label).toContain('Heart rate')
    expect(peerType('speaker')?.label).toContain('Speaker')
    expect(peerType('missing')).toBeUndefined()
  })

  it('derives live roster subtitles from params', () => {
    expect(peerDetail('hrm', defaultPeerParams('hrm', 'Heart rate 1'), '')).toBe(
      '72 BPM · advertising',
    )
    expect(peerDetail('scanner', { scanning: true, active: false, advCount: 3 }, '')).toBe(
      '3 adv reports',
    )
    expect(
      peerDetail(
        'speaker',
        { streamState: 'started', packets: 128, muted: false, discoverable: true },
        '',
      ),
    ).toBe('started · 128 pkts')
  })
})
