import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const controllerMocks = vi.hoisted(() => ({
  close: vi.fn(),
  onHostPacket: vi.fn(),
  ensureController: vi.fn(),
}))

vi.mock('@/bt/bumbleController', () => ({
  ensureController: controllerMocks.ensureController,
}))

import { attach, detach, getSnapshot, startController } from '@/hostBt'

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
    controllerMocks.onHostPacket.mockReset()
    controllerMocks.ensureController.mockReset()
    controllerMocks.ensureController.mockResolvedValue({
      name: 'test-controller',
      close: controllerMocks.close,
      onHostPacket: controllerMocks.onHostPacket,
      listPeers: () => [],
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
})
