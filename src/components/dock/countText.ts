/**
 * Counts in the dock's badges, said in words: `1 button` rather than `1 btn`,
 * `35.8K events · 10 threads` rather than `35821 evt · 10 thr`. A badge is
 * the row's summary while it is folded, so it should read without a key.
 */

import { compactCount } from '@/components/queueGraph/display'

/** A count with its noun, singular for one: `1 button`, `2 buttons`. */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The Trace row's badge. Past 10,000 the event count rounds (35.8K), which
 * also stops it flickering while events stream in.
 */
export function traceCounts(events: number, threads: number): string {
  return `${compactCount(events)} ${events === 1 ? 'event' : 'events'} · ${countOf(threads, 'thread')}`
}

/** The GPIO controller row's badge: how many of its pins a driver claims. */
export function pinsUsed(claimed: number, ngpios: number): string {
  return `${claimed} of ${countOf(ngpios, 'pin')} used`
}
