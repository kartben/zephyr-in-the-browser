/**
 * Test harness: a NetStack wired frame-to-frame against a FakeGuest, with a
 * virtual clock and optional frame dropping. Both ends emit synchronously,
 * so handshakes cascade to completion inside a single call stack; only
 * retransmission tests need the clock.
 */

import { NetStack, type StackConfig, type StackEvent } from '../stack'
import { FakeGuest } from './fakeGuest'

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Loopback {
  stack: NetStack
  guest: FakeGuest
  events: StackEvent[]
  framesToGuest: Uint8Array[]
  framesToStack: Uint8Array[]
  /** Advance the virtual clock and pump both TCP engines. */
  advance(ms: number): void
  now(): number
  /** Drop the next `n` frames headed to the guest (for retransmit tests). */
  dropToGuest(n: number): void
}

export function createLoopback(options: { fetchImpl?: typeof fetch | null; config?: StackConfig } = {}): Loopback {
  let nowMs = 1_700_000_000_000
  const random = seededRandom(0xc0ffee)
  const events: StackEvent[] = []
  const framesToGuest: Uint8Array[] = []
  const framesToStack: Uint8Array[] = []
  let dropRemaining = 0

  // Frames are delivered through a zero-delay queue rather than direct
  // recursion so neither engine re-enters itself on its own call stack.
  const pending: Array<() => void> = []
  let pumping = false
  const enqueue = (fn: () => void) => {
    pending.push(fn)
    if (pumping) return
    pumping = true
    while (pending.length > 0) pending.shift()!()
    pumping = false
  }

  const guest = new FakeGuest(
    {
      sendFrame: (frame) => {
        framesToStack.push(frame)
        enqueue(() => stack.onGuestFrame(frame))
      },
      now: () => nowMs,
      random,
    },
  )

  const stack = new NetStack(
    {
      sendFrame: (frame) => {
        framesToGuest.push(frame)
        if (dropRemaining > 0) {
          dropRemaining -= 1
          return
        }
        enqueue(() => guest.onFrame(frame))
      },
      now: () => nowMs,
      random,
      fetchImpl: options.fetchImpl ?? null,
      onEvent: (event) => events.push(event),
    },
    options.config,
  )

  return {
    stack,
    guest,
    events,
    framesToGuest,
    framesToStack,
    advance(ms: number) {
      const step = 50
      for (let left = ms; left > 0; left -= step) {
        nowMs += Math.min(step, left)
        stack.tick()
        guest.tick()
      }
    },
    now: () => nowMs,
    dropToGuest(n: number) {
      dropRemaining = n
    },
  }
}
