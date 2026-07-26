import { afterEach, describe, expect, it } from 'vitest'
import {
  FOURCC_AR24,
  attach,
  detach,
  getFrameSequence,
  getSnapshot,
} from '@/hostDisplay'

const FRAME_POINTER = 64
const FRAME_SEQUENCE_POINTER = 32

function displayModule(frameSeqPointer?: number) {
  const heap = new Uint8Array(new SharedArrayBuffer(4096))
  return {
    HEAPU8: heap,
    _qemu_browser_ramfb_get_width: () => 16,
    _qemu_browser_ramfb_get_height: () => 16,
    _qemu_browser_ramfb_get_stride: () => 64,
    _qemu_browser_ramfb_get_data: () => FRAME_POINTER,
    _qemu_browser_ramfb_get_fourcc: () => FOURCC_AR24,
    ...(frameSeqPointer === undefined
      ? {}
      : { _qemu_browser_ramfb_get_frame_seq_ptr: () => frameSeqPointer }),
  }
}

afterEach(() => detach())

describe('hostDisplay', () => {
  it('keeps the checksum fallback available for an older emulator artifact', () => {
    attach(displayModule())

    expect(getSnapshot()).toMatchObject({ available: true, frameSeqPointer: 0 })
    expect(getFrameSequence()).toBeNull()
  })

  it('reads the QEMU dirty sequence atomically when an artifact provides one', () => {
    const module = displayModule(FRAME_SEQUENCE_POINTER)
    const sequence = new Int32Array(module.HEAPU8.buffer, FRAME_SEQUENCE_POINTER, 1)
    Atomics.store(sequence, 0, 7)
    attach(module)

    expect(getSnapshot().frameSeqPointer).toBe(FRAME_SEQUENCE_POINTER)
    expect(getFrameSequence()).toBe(7)

    Atomics.store(sequence, 0, 8)
    expect(getFrameSequence()).toBe(8)
  })
})
