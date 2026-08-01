import { describe, expect, it } from 'vitest'
import { CHANGELOG } from './changelog'
import { APP_VERSION } from './version'

describe('CHANGELOG', () => {
  it('has at least one release with items', () => {
    expect(CHANGELOG.length).toBeGreaterThan(0)
    for (const release of CHANGELOG) {
      expect(release.version.length).toBeGreaterThan(0)
      expect(release.items.length).toBeGreaterThan(0)
      for (const item of release.items) {
        expect(item.text.length).toBeGreaterThan(0)
      }
    }
  })

  it('lists Unreleased first when present', () => {
    if (CHANGELOG[0]?.version === 'Unreleased') {
      expect(CHANGELOG[0].date).toBeNull()
    }
  })
})

describe('APP_VERSION', () => {
  it('is a non-empty semver-ish string from package.json', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
