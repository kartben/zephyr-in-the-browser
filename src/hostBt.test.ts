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

  it('does not load Bumble just because a board has an hci0 chardev', async () => {
    // Every A53 boot binds this chardev. Starting the controller here is what
    // made blinky and the shell pay for Pyodide.
    attach(fakeHciModule(new Uint8Array(0)))
    await vi.advanceTimersByTimeAsync(200)

    expect(controllerMocks.ensureController).not.toHaveBeenCalled()
    expect(getSnapshot()).toMatchObject({ available: true, phase: 'idle' })
  })

  it('starts on the guest’s first HCI packet and replays what it queued', async () => {
    let release: (handle: unknown) => void = () => {}
    controllerMocks.ensureController.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )

    const reset = Uint8Array.of(0x01, 0x03, 0x0c, 0x00)
    attach(fakeHciModule(reset))
    await vi.advanceTimersByTimeAsync(20)

    // The load is under way and the packet is held, not dropped.
    expect(controllerMocks.ensureController).toHaveBeenCalledOnce()
    expect(controllerMocks.onHostPacket).not.toHaveBeenCalled()
    expect(getSnapshot()).toMatchObject({ phase: 'loading', rxPackets: 1 })

    release({
      name: 'late-controller',
      addPeer: controllerMocks.addPeer,
      close: controllerMocks.close,
      onHostPacket: controllerMocks.onHostPacket,
      setPeerParam: controllerMocks.setPeerParam,
      peerParams: () => null,
      listPeers: () => [],
    })
    await vi.advanceTimersByTimeAsync(20)

    expect(controllerMocks.onHostPacket).toHaveBeenCalledOnce()
    expect(Array.from(controllerMocks.onHostPacket.mock.calls[0]![0])).toEqual(Array.from(reset))
    expect(getSnapshot()).toMatchObject({ phase: 'ready', controllerName: 'late-controller' })
  })

  it('keeps a failed preload visible when QEMU attaches', async () => {
    controllerMocks.ensureController.mockRejectedValueOnce(new Error('wheel download failed'))
    await startController()
    expect(getSnapshot()).toMatchObject({ phase: 'error' })

    attach(fakeHciModule(new Uint8Array(0)))
    await vi.advanceTimersByTimeAsync(20)

    // Not 'idle': the reason Bluetooth will not work is the whole message.
    expect(getSnapshot()).toMatchObject({
      available: true,
      phase: 'error',
      detail: 'wheel download failed',
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
