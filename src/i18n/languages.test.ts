import { describe, expect, it } from 'vitest'
import { canonicalTag, languageName, pickLanguage, resolveLanguage } from '@/i18n/languages'

const AVAILABLE = ['en', 'fr', 'pt-BR']

describe('pickLanguage', () => {
  it('takes the same tag, whatever its case', () => {
    expect(pickLanguage(['fr'], AVAILABLE)).toBe('fr')
    expect(pickLanguage(['pt-br'], AVAILABLE)).toBe('pt-BR')
  })

  it('reads a regional tag as its base language', () => {
    expect(pickLanguage(['fr-CA'], AVAILABLE)).toBe('fr')
  })

  it('reads a base language as a variety of it when that is all there is', () => {
    expect(pickLanguage(['pt'], AVAILABLE)).toBe('pt-BR')
    expect(pickLanguage(['pt-PT'], AVAILABLE)).toBe('pt-BR')
  })

  it('tries each wanted language in the reader’s order', () => {
    expect(pickLanguage(['de', 'fr-BE', 'en'], AVAILABLE)).toBe('fr')
    expect(pickLanguage(['en-GB', 'fr'], AVAILABLE)).toBe('en')
  })

  it('skips what is not a language tag, and gives up with null', () => {
    expect(pickLanguage(['not a tag!', 'fr'], AVAILABLE)).toBe('fr')
    expect(pickLanguage(['de', 'ja'], AVAILABLE)).toBeNull()
    expect(pickLanguage([], AVAILABLE)).toBeNull()
  })
})

describe('resolveLanguage', () => {
  const base = { search: '', stored: null, browser: [] as string[], available: AVAILABLE }

  it('falls back to English', () => {
    expect(resolveLanguage(base)).toEqual({ lang: 'en', source: 'default' })
  })

  it('follows the browser', () => {
    expect(resolveLanguage({ ...base, browser: ['fr-FR', 'en'] })).toEqual({
      lang: 'fr',
      source: 'browser',
    })
  })

  it('puts a saved choice over the browser', () => {
    expect(resolveLanguage({ ...base, stored: 'en', browser: ['fr'] })).toEqual({
      lang: 'en',
      source: 'store',
    })
  })

  it('puts ?lang= over everything', () => {
    expect(resolveLanguage({ ...base, search: '?app=blinky&lang=fr', stored: 'en' })).toEqual({
      lang: 'fr',
      source: 'query',
    })
  })

  it('passes over a language the page does not have', () => {
    expect(resolveLanguage({ ...base, search: '?lang=xx', stored: 'de', browser: ['fr'] })).toEqual(
      { lang: 'fr', source: 'browser' },
    )
  })
})

describe('canonicalTag', () => {
  it('canonicalises case and rejects junk', () => {
    expect(canonicalTag('PT-br')).toBe('pt-BR')
    expect(canonicalTag('zh-hans')).toBe('zh-Hans')
    expect(canonicalTag('')).toBeNull()
    expect(canonicalTag('fr_FR')).toBeNull()
  })
})

describe('languageName', () => {
  it('names a language in itself, capitalised', () => {
    expect(languageName('fr')).toBe('Français')
    expect(languageName('en')).toBe('English')
    expect(languageName('de')).toBe('Deutsch')
  })
})
