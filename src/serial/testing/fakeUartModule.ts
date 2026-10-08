/**
 * A stand-in for the emulator's uart1 chardev slot: the six
 * `_qemu_browser_uart1_*` exports over a plain heap, with a guest on the other
 * side that the test drives. For hostUart tests, and the mock backend's demo.
 */

export interface FakeUartModule {
  /** Pass to hostUart.attach(). */
  module: Record<string, unknown>
  /** What the page fed towards the guest, oldest first; take() empties it. */
  take(): number[]
  /** The guest transmits these bytes. */
  transmit(bytes: Iterable<number>): void
}

export function createFakeUartModule({
  inCapacity = 4096,
  outSize = 65536,
  /** A guest that sends straight back whatever it receives. */
  echo = false,
}: { inCapacity?: number; outSize?: number; echo?: boolean } = {}): FakeUartModule {
  const heap = new Uint8Array(outSize)
  let inbox: number[] = []
  let head = 0
  let tail = 0

  const transmit = (bytes: Iterable<number>) => {
    for (const b of bytes) {
      // Full: drop, as char-browser.c's browser_chr_write does.
      if (head - tail >= outSize) return
      heap[head % outSize] = b
      head = (head + 1) >>> 0
    }
  }

  const module: Record<string, unknown> = {
    HEAPU8: heap,
    _qemu_browser_uart1_feed: (value: number) => {
      if (inbox.length >= inCapacity) return -1
      if (echo) transmit([value])
      else inbox.push(value)
      return 0
    },
    _qemu_browser_uart1_ring: () => 0,
    _qemu_browser_uart1_ring_size: () => outSize,
    _qemu_browser_uart1_write_index: () => head,
    _qemu_browser_uart1_read_index: () => tail,
    _qemu_browser_uart1_set_read_index: (value: number) => {
      tail = value >>> 0
    },
  }

  return {
    module,
    take() {
      const out = inbox
      inbox = []
      return out
    },
    transmit,
  }
}
