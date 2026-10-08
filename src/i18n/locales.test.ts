import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LANGUAGES } from '@/i18n'
import { canonicalTag, SOURCE_LANGUAGE } from '@/i18n/languages'

/**
 * The locale files are where translators work, often through a translation
 * platform, so what they can get wrong is checked here rather than on the
 * page. A string a translation has not got to yet is fine: it shows in
 * English. What is not fine is a string that can never show (a key English
 * does not have), one that drops a value or a link (a `{{placeholder}}` or
 * `<tag>` English does not use), and a plural with a form missing, which
 * i18next quietly takes from English instead.
 */

const LOCALES_DIR = resolve(process.cwd(), 'src/locales')
const PLURAL = /_(zero|one|two|few|many|other)$/

type Tree = { [key: string]: string | Tree }

function load(code: string): Tree {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf8')) as Tree
}

/** Every string in a locale file, by its dotted key. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.set(path, value)
    else for (const [k, v] of flatten(value, path)) out.set(k, v)
  }
  return out
}

const placeholders = (text: string) =>
  new Set([...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]!))
const tags = (text: string) =>
  [...new Set([...text.matchAll(/<\/?(\w+)\s*\/?>/g)].map((m) => m[1]!))].sort()

const codes = readdirSync(LOCALES_DIR)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace('.json', ''))
  .sort()
const english = flatten(load(SOURCE_LANGUAGE))
const translations = codes.filter((code) => code !== SOURCE_LANGUAGE)

/** English's forms of a plural key: `tour.intro.stops` → its `_one` and `_other`. */
function englishForms(base: string): string[] {
  return [...english.keys()].filter((key) => key.replace(PLURAL, '') === base && PLURAL.test(key))
}

describe('src/locales/', () => {
  it('is what the page offers', () => {
    expect([...LANGUAGES].sort()).toEqual(codes)
  })

  it.each(codes)('%s.json is named by its language tag, in canonical case', (code) => {
    // `pt-BR`, not `pt_BR` or `pt-br`: what browsers send and platforms write.
    expect(canonicalTag(code)).toBe(code)
  })

  it.each(codes)('%s.json holds only strings', (code) => {
    const check = (tree: Tree, path: string): void => {
      for (const [key, value] of Object.entries(tree)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          check(value, `${path}${key}.`)
        } else {
          expect(typeof value, `${path}${key}`).toBe('string')
        }
      }
    }
    check(load(code), '')
  })

  it('has English plurals in both forms', () => {
    for (const key of english.keys()) {
      if (!PLURAL.test(key)) continue
      const base = key.replace(PLURAL, '')
      expect(english.has(`${base}_one`) && english.has(`${base}_other`), base).toBe(true)
    }
  })
})

describe.each(translations)('src/locales/%s.json', (code) => {
  const strings = flatten(load(code))
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories

  it('has no key English does not have', () => {
    // A misspelt or stale key would never show: the page asks for English's.
    const stray = [...strings.keys()].filter((key) => {
      if (english.has(key)) return false
      return !(PLURAL.test(key) && englishForms(key.replace(PLURAL, '')).length > 0)
    })
    expect(stray).toEqual([])
  })

  it('uses only the {{placeholders}} English does', () => {
    const wrong: string[] = []
    for (const [key, text] of strings) {
      const base = key.replace(PLURAL, '')
      const sources = english.has(key) ? [key] : englishForms(base)
      const allowed = new Set(sources.flatMap((k) => [...placeholders(english.get(k)!)]))
      if (PLURAL.test(key)) allowed.add('count')
      for (const name of placeholders(text)) if (!allowed.has(name)) wrong.push(`${key}: {{${name}}}`)
    }
    expect(wrong).toEqual([])
  })

  it('keeps the <tags> English uses, so links and code stay', () => {
    const wrong: string[] = []
    for (const [key, text] of strings) {
      const source = english.get(key) ?? english.get(`${key.replace(PLURAL, '')}_other`)
      if (source !== undefined && !same(tags(source), tags(text))) wrong.push(key)
    }
    expect(wrong).toEqual([])
  })

  it(`has every plural form ${code} needs (${categories.join(', ')})`, () => {
    const bases = new Set([...strings.keys()].filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')))
    const missing: string[] = []
    for (const base of bases) {
      for (const form of categories) if (!strings.has(`${base}_${form}`)) missing.push(`${base}_${form}`)
    }
    expect(missing).toEqual([])
  })
})

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
