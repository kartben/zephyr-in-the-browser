/**
 * The page's strings, in the reader's language.
 *
 * i18next with react-i18next, the most common setup for a React app, so the
 * locale files are plain i18next JSON: Weblate, Crowdin, Lokalise and the
 * i18n Ally editor extension read and write them as they are. Adding a
 * language is adding `src/locales/<code>.json`; see docs/i18n.md.
 *
 * English is bundled and set up synchronously on import, so a component (or a
 * test) rendered before startI18n() reads English rather than bare keys. Any
 * other language is a lazy chunk, loaded once by startI18n() before the first
 * render (main.tsx). A string a translation leaves out, or leaves empty, falls
 * back to English.
 *
 * The language is fixed for the life of the document. Changing it reloads the
 * page (chooseLanguage), the way switching mode does: a running tour's cards
 * hold the text it loaded, and a reload is the one path that gets every
 * string, tour and title right at once.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@/locales/en.json'
import {
  LANG_QUERY_PARAM,
  SOURCE_LANGUAGE,
  resolveLanguage,
  savedLanguage,
  saveLanguage,
  type ResolvedLanguage,
} from '@/i18n/languages'

type Messages = Record<string, unknown>

/** Every translation, by path, as a lazy chunk. English is the import above. */
const LOCALES = import.meta.glob<Messages>(['/src/locales/*.json', '!/src/locales/en.json'], {
  import: 'default',
})

function codeOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1, -'.json'.length)
}

/** Every language the page has, by code: English, then the rest in code order. */
export const LANGUAGES: readonly string[] = [
  SOURCE_LANGUAGE,
  ...Object.keys(LOCALES).map(codeOf).sort(),
]

void i18n.use(initReactI18next).init({
  resources: { [SOURCE_LANGUAGE]: { translation: en } },
  lng: SOURCE_LANGUAGE,
  fallbackLng: SOURCE_LANGUAGE,
  load: 'currentOnly',
  // Synchronous, with the English above already in hand.
  initAsync: false,
  // React escapes what it renders; escaping here too would show `&lt;`.
  interpolation: { escapeValue: false },
  // A translation platform writes "" for a string nobody has translated yet.
  returnEmptyString: false,
  // Every language is loaded before the first render, so nothing suspends.
  react: { useSuspense: false },
})

let resolved: ResolvedLanguage = { lang: SOURCE_LANGUAGE, source: 'default' }

/** The page's language and what chose it, once startI18n() has run. */
export function languageChoice(): ResolvedLanguage {
  return resolved
}

/** The language the page is in now, by code. */
export function currentLanguage(): string {
  return i18n.language || SOURCE_LANGUAGE
}

/**
 * Settle the page's language and load its strings. Call once, before the
 * first render. Never throws: a translation that will not load leaves the
 * page in English.
 */
export async function startI18n(): Promise<void> {
  resolved = resolveLanguage({
    search: location.search,
    stored: savedLanguage(),
    browser: navigator.languages ?? [],
    available: LANGUAGES,
  })
  if (resolved.lang !== SOURCE_LANGUAGE) {
    try {
      const messages = await LOCALES[`/src/locales/${resolved.lang}.json`]!()
      i18n.addResourceBundle(resolved.lang, 'translation', messages)
    } catch (err) {
      console.warn(`[i18n] could not load ${resolved.lang}; staying in English`, err)
      resolved = { lang: SOURCE_LANGUAGE, source: 'default' }
    }
  }
  await i18n.changeLanguage(resolved.lang)
  document.documentElement.lang = resolved.lang
  document.documentElement.dir = i18n.dir(resolved.lang)
}

/**
 * Switch the page to `code`, or back to the browser's language with null, and
 * reload. A `?lang=` in the address bar would outrank the choice, so it goes;
 * with storage blocked, the choice rides in `?lang=` instead.
 */
export function chooseLanguage(code: string | null): void {
  const params = new URLSearchParams(location.search)
  params.delete(LANG_QUERY_PARAM)
  if (!saveLanguage(code) && code !== null) params.set(LANG_QUERY_PARAM, code)
  const search = params.toString()
  if (search === location.search.replace(/^\?/, '')) location.reload()
  else location.search = search
}

export default i18n
