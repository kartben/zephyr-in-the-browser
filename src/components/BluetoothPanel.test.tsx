import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { BluetoothView } from './BluetoothPanel'
import {
  addPeer,
  attachMockDemo,
  detach,
  getSnapshot,
  removePeer,
  selectPeer,
  setPeerParam,
  type BtSnapshot,
} from '@/hostBt'

function html(snap: BtSnapshot, live = true): string {
  return renderToStaticMarkup(<BluetoothView snap={snap} live={live} />)
}

function text(snap: BtSnapshot, live = true): string {
  return html(snap, live).replace(/<[^>]+>/g, ' ')
}

describe('BluetoothView', () => {
  afterEach(() => detach())

  it('explains a missing hci0 chardev when not live', () => {
    const out = text(
      {
        available: false,
        phase: 'idle',
        detail: '',
        rxPackets: 0,
        txPackets: 0,
        controllerName: '',
        peers: [],
        selectedPeerId: null,
      },
      false,
    )
    expect(out).toContain('hci0')
    expect(out).toContain('features.json')
  })

  it('lists the controller on the air and offers Add peer', async () => {
    attachMockDemo()
    await addPeer('hrm')
    const out = text(getSnapshot())
    expect(out).toContain('Controller ready')
    expect(out).toContain('On the air')
    expect(out).toContain('zephyr-browser')
    expect(out).toContain('Heart rate 1')
    expect(out).toContain('Add peer')
    expect(html(getSnapshot())).toContain('aria-label="Peer type"')
    expect(html(getSnapshot())).toContain('Remove Heart rate 1')
    expect(html(getSnapshot())).not.toContain('Remove zephyr-browser')
  })

  it('opens the inspector when a peer is added', async () => {
    attachMockDemo()
    await addPeer('hrm')
    const out = text(getSnapshot())
    expect(out).toContain('72 BPM')
    expect(out).toContain('Body location')
    expect(out).toContain('Advertising')
    expect(getSnapshot().selectedPeerId).toBe('hrm-1')
    // Canvas/SVG pulse strip is present for the HRM inspector.
    expect(html(getSnapshot())).toContain('aria-hidden')
    expect(html(getSnapshot())).toMatch(/hrm-heart-fill/)
  })

  it('updates the roster subtitle when inspector params change', async () => {
    attachMockDemo()
    await addPeer('hrm')
    await setPeerParam('hrm-1', 'bpm', 96)
    await setPeerParam('hrm-1', 'advertising', false)
    const peer = getSnapshot().peers.find((p) => p.id === 'hrm-1')!
    expect(peer.detail).toBe('96 BPM · stopped')
  })

  it('clears the inspector when the selected peer is removed', async () => {
    attachMockDemo()
    await addPeer('scanner')
    expect(getSnapshot().selectedPeerId).toBe('scanner-1')
    await removePeer('scanner-1')
    expect(getSnapshot().selectedPeerId).toBeNull()
    expect(text(getSnapshot())).not.toContain('Adv reports')
  })

  it('deselects on a second click', async () => {
    attachMockDemo()
    await addPeer('advertiser')
    expect(getSnapshot().selectedPeerId).toBe('advertiser-1')
    selectPeer('advertiser-1')
    expect(getSnapshot().selectedPeerId).toBeNull()
  })
})
