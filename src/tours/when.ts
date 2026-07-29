/**
 * `when:` — the hit condition, borrowed name and all from DAP's `hitCondition`.
 *
 * A breakpoint inside a loop fires every pass, and most of the time a step only
 * wants the first one. Rather than a `SAMPLE_ONCE()` macro compiled into the
 * guest, the page counts hits and silently continues past the ones the step did
 * not ask for.
 *
 *     when: first          the first time through (the default for `repeat: yes`)
 *     when: hits == 4      the fourth
 *     when: hits >= 3      from the third on
 *     when: hits % 10 == 0 every tenth
 */

const COMPARE = /^hits\s*(==|!=|>=|<=|>|<)\s*(\d+)$/
const MODULO = /^hits\s*%\s*(\d+)\s*(==)?\s*(\d+)$/

export interface WhenResult {
  /** Show the step on this hit. */
  fires: boolean
  /** The condition could not be parsed; treated as "always". */
  invalid: boolean
}

/** Evaluate a step's condition for hit number `hits` (1-based). */
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
