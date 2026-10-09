/**
 * Which language the page speaks, and how it decides.
 *
 * A language exists when its file does: `src/locales/<code>.json` holds the
 * page's strings and `tours/<code>/` (optional) holds translated tours. There
 * is no list to keep in step, the same way a tour is just a file in `tours/`.
 * The code is a BCP 47 tag, as browsers and translation platforms spell it:
 * `fr`, `de`, `pt-BR`, `zh-Hans`.
 *
 * Pure, so the precedence rules are testable without a page. src/i18n/index.ts
 * feeds them the URL, the saved choice and the browser's languages.
 */

/** The language the page and the tours are written in, and fall back to. */
export const SOURCE_LANGUAGE = 'en'

/** `?lang=fr`: this visit in French, whatever was saved. Not remembered. */
export const LANG_QUERY_PARAM = 'lang'

/** The reader's choice from Settings. Absent means "follow the browser". */
const STORAGE_KEY = 'zephyr.lang'

/** A BCP 47 tag in canonical case (`pt-br` is `pt-BR`), or null when it is not one. */
export function canonicalTag(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag.trim())[0] ?? null
  } catch {
    return null
  }
}

/** The language of a tag without its region or script: `pt-BR` is `pt`. */
export function baseOf(tag: string): string {
  return tag.split('-')[0]!.toLowerCase()
}

/**
 * The best of `available` for a reader who wants `wanted`, most wanted first,
 * or null when none will do.
 *
 * Each wanted tag is tried in turn: the same tag, then its base language
 * (`fr-CA` reads `fr`), then another variety of it (`pt` reads `pt-BR`). Only
 * then is the next tag tried, so a reader who lists `fr-CA, en` gets French.
 */
export function pickLanguage(
  wanted: readonly string[],
  available: readonly string[],
): string | null {
  for (const raw of wanted) {
    const tag = canonicalTag(raw)
    if (tag === null) continue
    const exact = available.find((a) => a.toLowerCase() === tag.toLowerCase())
    if (exact) return exact
    const base = baseOf(tag)
    const related =
      available.find((a) => a.toLowerCase() === base) ?? available.find((a) => baseOf(a) === base)
    if (related) return related
  }
  return null
}

export type LanguageSource = 'query' | 'store' | 'browser' | 'default'

export interface ResolvedLanguage {
  lang: string
  source: LanguageSource
}

/**
 * The page's language. Precedence, highest first:
 *
 *  1. `?lang=`: a link that names a language, such as a workshop's.
 *  2. The language picked in Settings.
 *  3. The browser's languages, in its order.
 *  4. English.
 *
 * A step that names a language the page does not have falls through to the
 * next, so `?lang=xx` on a page with no `xx` reads as no `?lang=` at all.
 */
export function resolveLanguage(input: {
  search: string
  stored: string | null
  browser: readonly string[]
  available: readonly string[]
}): ResolvedLanguage {
  const { search, stored, browser, available } = input
  const asked = new URLSearchParams(search).get(LANG_QUERY_PARAM)
  const fromQuery = asked ? pickLanguage([asked], available) : null
  if (fromQuery) return { lang: fromQuery, source: 'query' }
  const fromStore = stored ? pickLanguage([stored], available) : null
  if (fromStore) return { lang: fromStore, source: 'store' }
  const fromBrowser = pickLanguage(browser, available)
  if (fromBrowser) return { lang: fromBrowser, source: 'browser' }
  return { lang: SOURCE_LANGUAGE, source: 'default' }
}

/**
 * A language's name in that language, as a picker lists it: `Français`,
 * `Deutsch`, `português (Brasil)`. The browser knows them all, so a new
 * language needs no name written down anywhere.
 */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    if (!name || name === code) return code
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1)
  } catch {
    return code
  }
}

/** The language saved from Settings, or null for "follow the browser". */
export function savedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Save the reader's choice, or forget it with null. False when storage is blocked. */
export function saveLanguage(code: string | null): boolean {
  try {
    if (code === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, code)
    return true
  } catch {
    return false
  }
}
