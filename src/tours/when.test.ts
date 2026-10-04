import { describe, expect, it } from 'vitest'
import type { TourTarget } from '@/tours/expr'
import { hitsFire, parseWhen, stateHolds, whenFires } from '@/tours/when'

const hitsThatFire = (when: string | null, upTo = 12) =>
  Array.from({ length: upTo }, (_, i) => i + 1).filter((hits) => whenFires(when, hits).fires)

describe('whenFires', () => {
  it('fires on every hit with no condition', () => {
    expect(hitsThatFire(null, 3)).toEqual([1, 2, 3])
    expect(hitsThatFire('', 3)).toEqual([1, 2, 3])
  })

  it('understands `first`', () => {
    expect(hitsThatFire('first', 4)).toEqual([1])
    expect(hitsThatFire('once', 4)).toEqual([1])
  })

  it('compares hit counts', () => {
    expect(hitsThatFire('hits == 3', 5)).toEqual([3])
    expect(hitsThatFire('hits >= 4', 5)).toEqual([4, 5])
    expect(hitsThatFire('hits < 3', 5)).toEqual([1, 2])
    expect(hitsThatFire('hits != 2', 3)).toEqual([1, 3])
  })

  it('takes every nth hit', () => {
    expect(hitsThatFire('hits % 4 == 0', 12)).toEqual([4, 8, 12])
    expect(hitsThatFire('hits % 5 == 1', 11)).toEqual([1, 6, 11])
  })

  it('reads a bare number as the hit to stop on', () => {
    expect(hitsThatFire('3', 5)).toEqual([3])
  })

  it('fires — and says so — when the condition is nonsense', () => {
    expect(whenFires('when the moon is full', 1)).toEqual({ fires: true, invalid: true })
  })
})

describe('parseWhen', () => {
  it('sorts a mixed list into predicates and hit conditions', () => {
    const { when, problems } = parseWhen(['$arg0 == readings', 'hits == 3', '_kernel as u32 == 0'])
    expect(problems).toEqual([])
    expect(when.hits).toEqual(['hits == 3'])
    expect(when.state.map((p) => p.text)).toEqual(['$arg0 == readings', '_kernel as u32 == 0'])
  })

  it('takes every spelling of the hit grammar as a hit condition', () => {
    for (const item of ['first', 'once', 'always', 'every', 'hits % 10 == 0', '4', 'HITS == 2']) {
      expect(parseWhen([item]).when, item).toEqual({ state: [], hits: [item] })
    }
  })

  it('reports what is neither, and keeps the rest', () => {
    const { when, problems } = parseWhen(['the moon is full', 'first'])
    expect(when).toEqual({ state: [], hits: ['first'] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('the moon is full')
  })

  it('ignores blank items', () => {
    expect(parseWhen(['', '  '])).toEqual({ when: { state: [], hits: [] }, problems: [] })
  })
})

describe('hitsFire', () => {
  const counted = (items: string[], upTo = 12) => {
    const { when } = parseWhen(items)
    return Array.from({ length: upTo }, (_, i) => i + 1).filter((hits) => hitsFire(when, hits))
  }

  it('fires on every counted hit with no hit condition', () => {
    expect(counted([], 3)).toEqual([1, 2, 3])
    expect(counted(['$arg0 == readings'], 3)).toEqual([1, 2, 3])
  })

  it('needs every hit condition of a list', () => {
    expect(counted(['hits >= 3', 'hits % 2 == 0'], 8)).toEqual([4, 6, 8])
  })
})

/** A guest whose memory is a plain map, counting what is read and when. */
function target(memory: Record<number, number>, registers: Record<string, number> = {}) {
  const reads: number[] = []
  const t: TourTarget = {
    pointerBytes: 4,
    symbol: (name) => ({ readings: 0x3000, counter: 0x3100, other: 0x3200 })[name] ?? null,
    register: (name) => registers[name] ?? null,
    async read(addr, length) {
      reads.push(addr)
      if (!(addr in memory)) return null
      const out = new Uint8Array(length)
      new DataView(out.buffer).setUint32(0, memory[addr]!, true)
      return out
    },
    label: () => null,
  }
  return { t, reads }
}

describe('stateHolds', () => {
  it('holds when every predicate does', async () => {
    const { when } = parseWhen(['$arg0 == readings', 'counter as u32 == 3'])
    const { t } = target({ 0x3100: 3 }, { arg0: 0x3000 })
    expect(await stateHolds(when, t)).toBe(true)
  })

  it('compares a register with a symbol without reading memory', async () => {
    // The cheapest predicate there is: both sides are values the stop already has.
    const { when } = parseWhen(['$arg0 == readings'])
    const { t, reads } = target({}, { arg0: 0x3000 })
    expect(await stateHolds(when, t)).toBe(true)
    expect(reads).toEqual([])
  })

  it('stops at the first predicate that does not hold', async () => {
    // Every read is time the guest spends frozen, so the order written is the
    // order paid for.
    const { when } = parseWhen(['$arg0 == readings', 'counter as u32 == 3', 'other as u32 == 1'])
    const missed = target({ 0x3100: 2, 0x3200: 1 }, { arg0: 0x3000 })
    expect(await stateHolds(when, missed.t)).toBe(false)
    expect(missed.reads).toEqual([0x3100])

    const elsewhere = target({ 0x3100: 3, 0x3200: 1 }, { arg0: 0x4000 })
    expect(await stateHolds(when, elsewhere.t)).toBe(false)
    expect(elsewhere.reads).toEqual([])
  })

  it('does not hold when a side cannot be read', async () => {
    const { when } = parseWhen(['counter as u32 == 0'])
    expect(await stateHolds(when, target({}).t)).toBe(false)
  })

  it('holds trivially with no predicates', async () => {
    expect(await stateHolds(parseWhen(['hits == 2']).when, target({}).t)).toBe(true)
  })
})
