import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { BluetoothView, btErrorSummary } from './BluetoothPanel'
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

  it('explains when Bluetooth is unavailable', () => {
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
    expect(out).toContain('Bluetooth isn’t available on this board yet')
    expect(out).toContain('Bluetooth sample')
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
    expect(out).not.toContain('Body location')
    expect(out).toContain('Advertising')
    expect(getSnapshot().selectedPeerId).toBe('hrm-1')
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

  it('opens a speaker inspector with A2DP sink controls', async () => {
    attachMockDemo()
    await addPeer('speaker')
    const out = text(getSnapshot())
    expect(out).toContain('Speaker 1')
    expect(out).toContain('A2DP')
    expect(out).toContain('SBC')
    expect(out).toContain('Discoverable')
    expect(out).toContain('128 pkts')
    expect(out).toContain('Enable sound')
  })
})

/** What a missing or corrupt Bumble wheel throws, as Pyodide reports it. */
const BAD_WHEEL = `Traceback (most recent call last):
  File "/lib/python3.14/site-packages/micropip/package_manager.py", line 202, in install
    await transaction.gather_requirements(requirements)
  File "/lib/python3.14/site-packages/micropip/transaction.py", line 96, in add_requirement
    return await self.add_requirement_from_url(req)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/lib/python3.14/site-packages/micropip/wheelinfo.py", line 161, in download
    with zipfile.ZipFile(io.BytesIO(self._data)) as zf:
         ~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/lib/python314.zip/zipfile/__init__.py", line 1538, in _RealGetContents
    raise BadZipFile("File is not a zip file")
zipfile.BadZipFile: File is not a zip file
`

describe('btErrorSummary', () => {
  it('reduces a Python traceback to its exception line', () => {
    expect(btErrorSummary(BAD_WHEEL)).toBe('BadZipFile: File is not a zip file')
  })

  it('keeps a plain message as its first line', () => {
    expect(btErrorSummary('Failed to fetch pyodide.js\nat load (x.js:1)')).toBe(
      'Failed to fetch pyodide.js',
    )
  })

  it('keeps dotted words inside the message', () => {
    expect(
      btErrorSummary('Traceback (most recent call last):\nValueError: bad value in a.b'),
    ).toBe('ValueError: bad value in a.b')
  })

  it('still says something when the controller threw nothing readable', () => {
    expect(btErrorSummary('')).toBe('no reason given')
  })
})

describe('BluetoothView error state', () => {
  const failed: BtSnapshot = {
    available: true,
    phase: 'error',
    detail: BAD_WHEEL,
    rxPackets: 1,
    txPackets: 0,
    controllerName: '',
    peers: [],
    selectedPeerId: null,
  }

  it('shows the cause and Retry, with the traceback folded away', () => {
    const out = text(failed)
    expect(out).toContain('BadZipFile: File is not a zip file')
    expect(out).toContain('Retry')
    expect(out).toContain('Details')
    expect(out).not.toContain('micropip/transaction.py')
    expect(html(failed)).toContain('aria-expanded="false"')
  })

  it('marks the phase pill with the destructive colours', () => {
    expect(html(failed)).toMatch(/class="[^"]*text-destructive[^"]*">Error</)
  })

  it('offers no Details fold when the cause is all there is', () => {
    const out = text({ ...failed, detail: 'emulator went away' })
    expect(out).toContain('emulator went away')
    expect(out).not.toContain('Details')
  })
})
