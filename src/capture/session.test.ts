import { describe, expect, it } from 'vitest'
import {
  CAPTURE_FORMAT,
  CAPTURE_VERSION,
  GESTURE_MS,
  IDLE_MS,
  NEGATIVE_MS,
  countTakes,
  isGesture,
  loadSession,
  newSession,
  parseSession,
  planRound,
  roundRow,
  saveSession,
  serializeSession,
  sessionFileName,
  type DeviceInfo,
  type Take,
} from './session'

const device: DeviceInfo = {
  userAgent: 'test',
  platform: 'Android',
  model: 'Pixel 7',
  mobile: true,
  screen: [412, 915],
  pixelRatio: 2.625,
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed / 2 ** 31
  }
}

function take(label: Take['label']): Take {
  return { label, hold: 'recommended', startedAt: '2026-10-05T08:00:00.000Z', cueMs: 3000, samples: [[0, 0, 0, 9.81]] }
}

class MemoryStorage {
  private items = new Map<string, string>()
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
}

describe('planRound', () => {
  it('asks for each gesture `reps` times, then free movement and stillness', () => {
    const plan = planRound(5, seeded(1))
    expect(plan).toHaveLength(17)
    const gestures = plan.slice(0, 15)
    for (const label of ['wing', 'ring', 'slope'] as const) {
      expect(gestures.filter((t) => t.label === label)).toHaveLength(5)
    }
    expect(gestures.every((t) => t.durationMs === GESTURE_MS)).toBe(true)
    expect(plan.slice(15)).toEqual([
      { label: 'negative', durationMs: NEGATIVE_MS },
      { label: 'idle', durationMs: IDLE_MS },
    ])
  })

  it('shuffles the gestures rather than grouping them', () => {
    const labels = planRound(5, seeded(7))
      .slice(0, 15)
      .map((t) => t.label)
    const grouped = [...labels].sort()
    expect(labels).not.toEqual(grouped)
  })
})

describe('isGesture', () => {
  it('tells gestures from free takes', () => {
    expect(isGesture('ring')).toBe(true)
    expect(isGesture('negative')).toBe(false)
    expect(isGesture('idle')).toBe(false)
  })
})

describe('newSession', () => {
  it('names the session by time plus a random suffix', () => {
    const session = newSession(device, new Date('2026-10-05T08:12:33.456Z'), () => 0.5)
    expect(session.id).toBe('2026-10-05T08-12-33Z-800000')
    expect(session.format).toBe(CAPTURE_FORMAT)
    expect(session.version).toBe(CAPTURE_VERSION)
    expect(session.takes).toEqual([])
    expect(sessionFileName(session)).toBe('magic-wand-2026-10-05T08-12-33Z-800000.json')
  })
})

describe('countTakes', () => {
  it('counts takes per label', () => {
    const session = { ...newSession(device), takes: [take('wing'), take('wing'), take('idle')] }
    expect(countTakes(session)).toEqual({ wing: 2, ring: 0, slope: 0, negative: 0, idle: 1 })
  })
})

describe('roundRow', () => {
  it('keeps a tenth of a millisecond and a thousandth of a reading', () => {
    expect(roundRow([12.345, 9.80665, -0.12345, 1 / 3])).toEqual([12.3, 9.807, -0.123, 0.333])
  })
})

describe('serialization', () => {
  it('round-trips a session', () => {
    const session = { ...newSession(device), takes: [take('slope')] }
    expect(parseSession(serializeSession(session))).toEqual(session)
  })

  it('refuses files that are not captures', () => {
    expect(() => parseSession('{"format":"other"}')).toThrow(/not a Magic Wand capture/)
    expect(() => parseSession(JSON.stringify({ format: CAPTURE_FORMAT, version: 99, takes: [] }))).toThrow(/version 99/)
    expect(() => parseSession(JSON.stringify({ format: CAPTURE_FORMAT, version: CAPTURE_VERSION }))).toThrow(/no takes/)
  })
})

describe('saveSession / loadSession', () => {
  it('keeps the session in storage', () => {
    const storage = new MemoryStorage() as unknown as Storage
    const session = { ...newSession(device), takes: [take('ring')] }
    expect(saveSession(session, storage)).toBe(true)
    expect(loadSession(storage)).toEqual(session)
  })

  it('reports a storage that will not take it, and works without one', () => {
    const full = {
      setItem() {
        throw new Error('QuotaExceededError')
      },
      getItem() {
        throw new Error('SecurityError')
      },
    } as unknown as Storage
    const session = newSession(device)
    expect(saveSession(session, full)).toBe(false)
    expect(loadSession(full)).toBeNull()
    expect(saveSession(session, null)).toBe(false)
    expect(loadSession(null)).toBeNull()
  })
})
