import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The seven-segment latch, driven the way it will be once GPIO executes in
 * `deviceWorker.ts`: the worker retains every output word and the page replays
 * the batch through the mirror in `devices/gpio.ts`.
 *
 * This is the regression that gates the whole batching design. Zephyr's
 * gpio-7-segment driver lights one digit at a time, so the page only ever sees
 * a single digit of the scan in any given word. If a batch collapsed to its
 * endpoint, two of the three digits here would read 0, and the display would be
 * confidently wrong rather than visibly late.
 */

const outputs = { word: 0 }
const outputListeners = new Set<() => void>()

// The latch coalesces its React wakeups to a frame, which Node has no clock
// for. Only the wakeup is deferred: `snapshot` is recomputed synchronously
// before the rAF guard, so stubbing this out leaves what we assert on intact.
vi.stubGlobal('requestAnimationFrame', () => 0)

const displays = [
  {
    id: '/digi-display',
    label: '7-segment LED',
    columns: 3,
    rows: 1,
    refreshPeriodMs: 1,
    segments: [8, 9, 10, 11, 12, 13, 14, 15].map((id) => ({ id, activeHigh: false })),
    digits: [5, 6, 7].map((id) => ({ id, activeHigh: true })),
  },
]

vi.mock('@/hostGpio', () => ({
  getSevenSegs: () => displays,
  isOutputHigh: (pin: number) => (outputs.word & (1 << pin)) !== 0,
  subscribeOutputs: (fn: () => void) => {
    outputListeners.add(fn)
    return () => outputListeners.delete(fn)
  },
}))

const { getSnapshot, refreshForTest } = await import('@/hostSevenSeg')
const { createGpioModel } = await import('@/virtio/devices/gpio')
import type { GpioBatch } from '@/virtio/devices/gpioProtocol'

/**
 * The real wiring from `src/hostGpio.ts`: a model notification updates the
 * output word and then fires the synchronous output observers, of which the
 * latch is one.
 */
function mirror() {
  const model = createGpioModel('gpio')
  model.setRemote(() => {})
  model.subscribe(() => {
    outputs.word = model.getOutputs()
    for (const fn of outputListeners) fn()
  })
  return model
}

function batch(edges: number[], over: Partial<GpioBatch> = {}): GpioBatch {
  return {
    edges: new Uint32Array(edges),
    dropped: 0,
    inputs: 0,
    outputs: edges.at(-1) ?? 0,
    ngpio: 16,
    directions: new Uint8Array(16),
    ...over,
  }
}

/** One multiplex frame: drive the segment bus (active low), then the common. */
function frameWords(digitPin: number, segmentMask: number): number[] {
  let segments = 0
  for (let i = 0; i < 8; i++) {
    if ((segmentMask & (1 << i)) === 0) segments |= 1 << (8 + i) // dark = high
  }
  // Blank the commons, write the bus, then select the digit. Three words, the
  // way a real scan moves, so the sequence is not trivially order-independent.
  return [segments, segments, segments | (1 << digitPin)]
}

/** "8." then "1" then "3" across the three digits. */
const SCAN: Array<[number, number]> = [
  [5, 0xff],
  [6, 0x06],
  [7, 0x4f],
]

const EXPECTED_DIGITS = [0xff, 0x06, 0x4f]

function scanWords(): number[] {
  return SCAN.flatMap(([pin, mask]) => frameWords(pin, mask))
}

/**
 * Blank every latched digit. Simply zeroing the output word is not enough, and
 * that is the latch working as intended: a digit holds its pattern until its
 * common is selected again, so the only way to clear one is to scan it dark.
 */
function reset() {
  outputs.word = 0
  refreshForTest()
  const m = mirror()
  m.applyBatch(batch(SCAN.flatMap(([pin]) => frameWords(pin, 0x00))))
  outputs.word = 0
  refreshForTest()
}

describe('hostSevenSeg under batched edge replay', () => {
  // Deliberately not clearing `outputListeners`: the latch subscribes at import
  // time, so dropping it here would silently test nothing at all.
  beforeEach(reset)

  it('latches every digit from a single batch covering a whole scan', () => {
    mirror().applyBatch(batch(scanWords()))
    expect(getSnapshot().displays[0]!.digits).toEqual(EXPECTED_DIGITS)
  })

  it('matches per-edge delivery exactly', () => {
    const words = scanWords()

    mirror().applyBatch(batch(words))
    const batched = getSnapshot().displays[0]!.digits

    reset()
    const m = mirror()
    for (const word of words) m.applyBatch(batch([word]))
    const perEdge = getSnapshot().displays[0]!.digits

    expect(batched).toEqual(perEdge)
    expect(batched).toEqual(EXPECTED_DIGITS)
  })

  it('would be wrong if the batch collapsed to its endpoint', () => {
    // Guards the guard: proves the assertions above can actually fail, so a
    // future change that quietly stops replaying does not pass silently.
    const words = scanWords()
    mirror().applyBatch(batch([words.at(-1)!]))
    const digits = getSnapshot().displays[0]!.digits
    expect(digits).not.toEqual(EXPECTED_DIGITS)
    expect(digits[0]).toBe(0)
    expect(digits[1]).toBe(0)
  })

  it('holds the previous scan across a batch that dropped edges', () => {
    const m = mirror()
    m.applyBatch(batch(scanWords()))
    expect(getSnapshot().displays[0]!.digits).toEqual(EXPECTED_DIGITS)

    // Overflow: resynchronise to the endpoint rather than latch a partial scan.
    // The digit the endpoint selects updates; the others keep what they had,
    // which is exactly what a real display does between refreshes.
    m.applyBatch(batch(frameWords(5, 0x06), { dropped: 12 }))
    const digits = getSnapshot().displays[0]!.digits
    expect(digits[0]).toBe(0x06)
    expect(digits[1]).toBe(EXPECTED_DIGITS[1])
    expect(digits[2]).toBe(EXPECTED_DIGITS[2])
  })
})
