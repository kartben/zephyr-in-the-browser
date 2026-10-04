/**
 * `when:`, the hit a step shows on.
 *
 * A breakpoint inside a loop fires every pass, and most of the time a step only
 * wants the first one. Rather than a `SAMPLE_ONCE()` macro compiled into the
 * guest, the page counts hits and silently continues past the ones the step did
 * not ask for.
 *
 * Two kinds of item, and a list means all of them:
 *
 *     when: first          hit conditions, DAP's `hitCondition` spelt out: the
 *     when: hits == 4      first time through, the fourth, from the third on,
 *     when: hits >= 3      every tenth
 *     when: hits % 10 == 0
 *
 *     when: $arg0 == readings          state predicates, in the `check:`
 *     when: _kernel as u32 == 0        grammar: what the target looks like
 *                                      at the stop
 *
 * Predicates come first, and a hit where one of them is false is not counted
 * at all. So
 *
 *     when:
 *       - $arg0 == readings
 *       - hits == 3
 *
 * is the third put to `readings`, however many puts to other queues went by in
 * between. A hot kernel function serves every caller in the system, and this
 * is how a step picks out the one the prose is about.
 */

import type { TourTarget } from '@/tours/expr'
import { evalPredicate, parsePredicate, type PredicateSpec } from '@/tours/predicate'

const COMPARE = /^hits\s*(==|!=|>=|<=|>|<)\s*(\d+)$/
const MODULO = /^hits\s*%\s*(\d+)\s*(==)?\s*(\d+)$/
/** Written as a hit condition, whether or not it is a valid one. */
const HIT_LIKE = /^hits\s*(==|!=|>=|<=|>|<|%)/i

export interface WhenResult {
  /** Show the step on this hit. */
  fires: boolean
  /** The condition could not be parsed; treated as "always". */
  invalid: boolean
}

/** A step's `when:`, sorted into what is checked and what is counted. */
export interface WhenSpec {
  /** State predicates. A hit only counts while every one of them holds. */
  state: PredicateSpec[]
  /** Hit conditions, every one of which must fire for the step to show. */
  hits: string[]
}

/** Evaluate one hit condition for hit number `hits` (1-based). */
export function whenFires(when: string | null, hits: number): WhenResult {
  if (when === null || when.trim() === '') return { fires: true, invalid: false }
  const text = when.trim().toLowerCase()
  if (text === 'first' || text === 'once') return { fires: hits === 1, invalid: false }
  if (text === 'always' || text === 'every') return { fires: true, invalid: false }

  const modulo = MODULO.exec(text)
  if (modulo) {
    const divisor = Number(modulo[1])
    if (divisor > 0) return { fires: hits % divisor === Number(modulo[3]), invalid: false }
  }

  const compare = COMPARE.exec(text)
  if (compare) {
    const rhs = Number(compare[2])
    switch (compare[1]) {
      case '==':
        return { fires: hits === rhs, invalid: false }
      case '!=':
        return { fires: hits !== rhs, invalid: false }
      case '>=':
        return { fires: hits >= rhs, invalid: false }
      case '<=':
        return { fires: hits <= rhs, invalid: false }
      case '>':
        return { fires: hits > rhs, invalid: false }
      case '<':
        return { fires: hits < rhs, invalid: false }
    }
  }

  const bare = /^(\d+)$/.exec(text)
  if (bare) return { fires: hits === Number(bare[1]), invalid: false }

  return { fires: true, invalid: true }
}

/**
 * Sort `when:` items into hit conditions and state predicates.
 *
 * `hits` compared with a number is always the hit counter, so a guest variable
 * that happens to be called `hits` needs a format to be read instead
 * (`hits as u32 == 3`). Items that are neither kind are reported and dropped,
 * which leaves the step firing as if they were not there.
 */
export function parseWhen(items: readonly string[]): { when: WhenSpec; problems: string[] } {
  const when: WhenSpec = { state: [], hits: [] }
  const problems: string[] = []
  for (const item of items) {
    const text = item.trim()
    if (text === '') continue
    if (!whenFires(text, 1).invalid) {
      when.hits.push(text)
      continue
    }
    if (HIT_LIKE.test(text)) {
      problems.push(`\`when: ${text}\` is not a hit condition (\`first\`, \`hits == 3\`, \`hits % 10 == 0\`)`)
      continue
    }
    // Anything else is a state predicate, or a mistake the predicate parser
    // can name: `when: the moon is full` has no comparison.
    const parsed = parsePredicate(text)
    if (parsed.ok) when.state.push(parsed.predicate)
    else problems.push(`\`when: ${text}\` ${parsed.error}`)
  }
  return { when, problems }
}

/** Whether a counted hit, number `hits`, is one the step shows on. */
export function hitsFire(when: WhenSpec, hits: number): boolean {
  return when.hits.every((condition) => whenFires(condition, hits).fires)
}

/**
 * Whether every state predicate holds at this stop.
 *
 * In the order written, and no further than the first that does not: each one
 * can cost a memory read, on a guest frozen until the answer comes back. A
 * predicate that cannot be read does not hold.
 */
export async function stateHolds(when: WhenSpec, target: TourTarget): Promise<boolean> {
  for (const predicate of when.state) {
    try {
      if (!(await evalPredicate(predicate, target)).pass) return false
    } catch {
      return false
    }
  }
  return true
}
