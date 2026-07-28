import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const controllerMocks = vi.hoisted(() => ({
  addPeer: vi.fn(),
  close: vi.fn(),
  onHostPacket: vi.fn(),
  setPeerParam: vi.fn(),
  ensureController: vi.fn(),
}))

vi.mock('@/bt/bumbleController', () => ({
  ensureController: controllerMocks.ensureController,
}))

import { addPeer, attach, detach, getSnapshot, setPeerParam, startController } from '@/hostBt'

function fakeHciModule(packet: Uint8Array) {
  const heap = new Uint8Array(64)
  heap.set(packet)
  let read = 0

  return {
    _qemu_browser_hci_feed: () => 0,
    _qemu_browser_hci_ring: () => 0,
    _qemu_browser_hci_ring_size: () => heap.length,
    _qemu_browser_hci_read_index: () => read,
    _qemu_browser_hci_write_index: () => packet.length,
    _qemu_browser_hci_set_read_index: (value: number) => {
      read = value
    },
    HEAPU8: heap,
  }
}

describe('host Bluetooth startup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    controllerMocks.close.mockReset()
    controllerMocks.addPeer.mockReset()
    controllerMocks.onHostPacket.mockReset()
    controllerMocks.setPeerParam.mockReset()
    controllerMocks.ensureController.mockReset()
    controllerMocks.addPeer.mockResolvedValue({
      id: 'hrm-1',
      typeId: 'hrm',
      name: 'Heart rate 1',
      detail: '72 BPM · advertising',
    })
    controllerMocks.ensureController.mockResolvedValue({
      name: 'test-controller',
      addPeer: controllerMocks.addPeer,
      close: controllerMocks.close,
      onHostPacket: controllerMocks.onHostPacket,
      setPeerParam: controllerMocks.setPeerParam,
      peerParams: () => null,
      listPeers: () =>
        controllerMocks.addPeer.mock.calls.length > 0
          ? [
              {
                id: 'hrm-1',
                typeId: 'hrm',
                name: 'Heart rate 1',
                detail: '72 BPM · advertising',
              },
            ]
          : [],
    })
  })

  afterEach(() => {
    detach()
    vi.useRealTimers()
  })

  it('prepares Bumble before a chardev exists and preserves it when QEMU attaches', async () => {
    await startController()

    expect(getSnapshot()).toMatchObject({
      available: false,
      phase: 'ready',
      controllerName: 'test-controller',
    })

    // HCI Reset, queued by the guest before the page-side poller attaches.
    const reset = Uint8Array.of(0x01, 0x03, 0x0c, 0x00)
    attach(fakeHciModule(reset))
    await vi.advanceTimersByTimeAsync(20)

    expect(controllerMocks.close).not.toHaveBeenCalled()
    expect(controllerMocks.onHostPacket).toHaveBeenCalledOnce()
    expect(Array.from(controllerMocks.onHostPacket.mock.calls[0]![0])).toEqual(Array.from(reset))
    expect(getSnapshot()).toMatchObject({
      available: true,
      phase: 'ready',
      rxPackets: 1,
    })
  })

  it('applies heart-rate changes to the live Bumble peer', async () => {
    await startController()
    await addPeer('hrm')
    await setPeerParam('hrm-1', 'bpm', 96)

    expect(controllerMocks.setPeerParam).toHaveBeenCalledWith('hrm-1', 'bpm', 96)
    expect(getSnapshot().peers.find((peer) => peer.id === 'hrm-1')?.params?.bpm).toBe(96)
  })
})
