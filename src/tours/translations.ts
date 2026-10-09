/**
 * Tours in other languages.
 *
 * A translation is `tours/<lang>/<tour id>.tour.md`: a copy of
 * `tours/<tour id>.tour.md` with its words translated. The title, the
 * introduction, each heading and its prose, and the reader-facing lines in a
 * ```tour block (`await:`, `pass:`, `fail:`, a `memory:` block's `note:` and
 * a `watch:` row's label) are the translator's. Everything else is the stage
 * directions, and stays exactly as the source has it: where each step stops,
 * what it reads, what it checks, which views it opens.
 *
 * That rule is what lets a translation be an ordinary, readable Markdown file
 * and still be safe to run. `mismatches` holds a translation to it, the tests
 * hold every translation in the repository to it, and the page falls back on
 * the English tour, with a warning in the console, for one that does not line
 * up: a step that stops somewhere the English one does not is worse than a
 * step in English. Since the steps line up one for one, `?step=` links, the
 * outline and the gallery count mean the same in every language.
 *
 * Bundled like the tours themselves (src/tours/catalog.ts), as lazy chunks.
 */

import { SOURCE_LANGUAGE } from '@/i18n/languages'
import { loadTourSource } from '@/tours/catalog'
import { parseTour, placedViews, type TourDoc, type TourStep } from '@/tours/parse'

const TRANSLATIONS = import.meta.glob('/tours/*/*.tour.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

/** Where the `lang` translation of a tour lives. */
export function translationPath(tourId: string, lang: string): string {
  return `tours/${lang}/${tourId}.tour.md`
}

/** Every translated tour in the bundle, as `{ lang, tourId }`. */
export function tourTranslations(): Array<{ lang: string; tourId: string }> {
  return Object.keys(TRANSLATIONS)
    .map((path) => {
      const [, , lang, file] = path.split('/')
      return { lang: lang!, tourId: file!.replace('.tour.md', '') }
    })
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.tourId.localeCompare(b.tourId))
}

/** True when the bundle has the `lang` translation of a tour. */
export function hasTranslation(tourId: string, lang: string): boolean {
  return `/${translationPath(tourId, lang)}` in TRANSLATIONS
}

/** The front-matter keys a translation keeps, by the TourDoc field each fills. */
const FRONT_MATTER = { sample: 'sample', showSource: 'source', sources: 'sources', next: 'next' } as const

/** Step fields as their directive spells them, where the two differ. */
const DIRECTIVE_NAMES: Record<string, string> = {
  threadNames: 'threads',
  placed: '{view} lines in the prose',
}

/**
 * A step with its words taken out: what a translation keeps as the source has
 * it. Optional text keeps only whether it is there, so a translation cannot
 * drop an `await:` and change how the step is reached.
 */
function mechanicsOf(step: TourStep): Record<string, unknown> {
  const out: Record<string, unknown> = { ...step }
  delete out.index
  delete out.title
  delete out.body
  out.await = step.await !== null
  out.pass = step.pass !== null
  out.fail = step.fail !== null
  out.memory = step.memory && { ...step.memory, note: step.memory.note !== null }
  out.watch = step.watch.map((w) => ({ expr: w.expr, format: w.format, label: w.label !== null }))
  // `{watch}` on a line of its own puts a view in the prose; where is the
  // translator's call, which views are not.
  out.placed = [...placedViews(step.body)].sort()
  return out
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * How a translation fails to line up with its source tour, one line per
 * difference, or none when it is safe to run in its place.
 */
export function mismatches(source: TourDoc, translated: TourDoc): string[] {
  const out: string[] = []
  for (const [field, key] of Object.entries(FRONT_MATTER) as Array<
    [keyof typeof FRONT_MATTER, string]
  >) {
    if (!same(source[field], translated[field])) out.push(`front matter \`${key}:\` differs`)
  }
  if (Boolean(source.intro) !== Boolean(translated.intro)) {
    out.push(source.intro ? 'the introduction is missing' : 'the source has no introduction')
  }
  if (Boolean(source.outro) !== Boolean(translated.outro)) {
    out.push(source.outro ? 'the closing section is missing' : 'the source has no closing section')
  }
  if (source.steps.length !== translated.steps.length) {
    out.push(`${translated.steps.length} steps where the source has ${source.steps.length}`)
    return out
  }
  source.steps.forEach((step, i) => {
    const a = mechanicsOf(step)
    const b = mechanicsOf(translated.steps[i]!)
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (same(a[key], b[key])) continue
      const name = DIRECTIVE_NAMES[key] ?? `${key}:`
      out.push(`step ${i + 1} (${step.title}): \`${name}\` differs`)
    }
  })
  for (const problem of translated.problems) {
    if (!source.problems.includes(problem)) out.push(problem)
  }
  return out
}

/**
 * The translation when it lines up with its source, else the source, saying
 * why in the console. `path` names the translation in that warning.
 */
export function pickTranslation(source: TourDoc, translated: TourDoc, path: string): TourDoc {
  const wrong = mismatches(source, translated)
  if (wrong.length === 0) return translated
  console.warn(
    `[tour] ${path} does not line up with its English tour, so the tour runs in English:\n  ` +
      wrong.join('\n  '),
  )
  return source
}

/**
 * A tour in `lang`, or in English when it has no translation there, or one
 * that does not line up. Null when there is no such tour. Never throws.
 */
export async function loadLocalizedTour(tourId: string, lang: string): Promise<TourDoc | null> {
  const text = await loadTourSource(tourId)
  if (text === null) return null
  const source = parseTour(text)
  const path = translationPath(tourId, lang)
  const load = TRANSLATIONS[`/${path}`]
  if (lang === SOURCE_LANGUAGE || !load) return source
  try {
    return pickTranslation(source, parseTour(await load()), path)
  } catch {
    // A chunk that will not load reads the same as no translation.
    return source
  }
}
