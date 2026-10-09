import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseTour } from '@/tours/parse'
import {
  loadLocalizedTour,
  mismatches,
  pickTranslation,
  tourTranslations,
} from '@/tours/translations'

/**
 * A translated tour runs in place of its English one, so it has to stop where
 * that one stops and read what it reads: only the words may differ. Every
 * translation in `tours/<lang>/` is held to that here, the way guided.test.ts
 * holds every tour to parsing cleanly.
 */

const TOURS_DIR = resolve(process.cwd(), 'tours')
const LOCALES_DIR = resolve(process.cwd(), 'src/locales')

function translationFiles(): Array<{ lang: string; file: string }> {
  return readdirSync(TOURS_DIR)
    .filter((entry) => statSync(join(TOURS_DIR, entry)).isDirectory())
    .flatMap((lang) =>
      readdirSync(join(TOURS_DIR, lang))
        .filter((file) => file.endsWith('.tour.md'))
        .map((file) => ({ lang, file })),
    )
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.file.localeCompare(b.file))
}

const read = (...parts: string[]) => readFileSync(join(TOURS_DIR, ...parts), 'utf8')
const cases = translationFiles().map(({ lang, file }) => [`${lang}/${file}`, lang, file] as const)

describe('tours/<lang>/', () => {
  it('is discovered from the files themselves', () => {
    expect(tourTranslations()).toEqual(
      translationFiles().map(({ lang, file }) => ({ lang, tourId: file.replace('.tour.md', '') })),
    )
  })

  it.each(cases)('%s is in a language the page has', (_name, lang) => {
    // The page offers a language when it has strings for it; a tour alone
    // would never be picked.
    expect(existsSync(join(LOCALES_DIR, `${lang}.json`)), `needs src/locales/${lang}.json`).toBe(
      true,
    )
  })

  it.each(cases)('%s translates a tour that exists', (_name, _lang, file) => {
    expect(existsSync(join(TOURS_DIR, file)), `no tours/${file} to translate`).toBe(true)
  })

  it.each(cases)('%s parses with no authoring errors', (_name, lang, file) => {
    expect(parseTour(read(lang, file)).problems).toEqual([])
  })

  it.each(cases)('%s lines up with the English tour', (_name, lang, file) => {
    // Only the words are the translator's: copy any ```tour block, front
    // matter key or `{view}` line from the English file as it is.
    expect(mismatches(parseTour(read(file)), parseTour(read(lang, file)))).toEqual([])
  })
})

const SOURCE = `---
tour: Blinky
sample: samples/basic/blinky
next: basic_button
---

What this tour is about.

## The pin

\`\`\`tour
at: main.c:/gpio_pin_toggle_dt/
await: Press **SW0**.
watch:
  - pin = led+1p as u8
memory:
  at: led
  len: 16
  note: the spec
\`\`\`

The pin is in the spec.

{watch}

## Done

That is all.
`

const FRENCH = `---
tour: Blinky en français
sample: samples/basic/blinky
next: basic_button
---

De quoi parle cette visite.

## La broche

\`\`\`tour
at: main.c:/gpio_pin_toggle_dt/
await: Appuyez sur **SW0**.
watch:
  - broche = led+1p as u8
memory:
  at: led
  len: 16
  note: la spec
\`\`\`

{watch}

La broche est dans la spec.

## Terminé

C'est tout.
`

describe('mismatches', () => {
  const source = parseTour(SOURCE)

  it('lets every word change, and where a view sits in the prose', () => {
    expect(mismatches(source, parseTour(FRENCH))).toEqual([])
  })

  it('catches a step that stops somewhere else', () => {
    const moved = parseTour(FRENCH.replace('/gpio_pin_toggle_dt/', '/k_msleep/'))
    expect(mismatches(source, moved)).toEqual(['step 1 (The pin): `at:` differs'])
  })

  it('catches a watch that reads something else, but not a renamed one', () => {
    const reread = parseTour(FRENCH.replace('led+1p as u8', 'led as u32'))
    expect(mismatches(source, reread)).toEqual(['step 1 (The pin): `watch:` differs'])
  })

  it('catches an `await:` dropped, which changes how the step is reached', () => {
    const dropped = parseTour(FRENCH.replace('await: Appuyez sur **SW0**.\n', ''))
    expect(mismatches(source, dropped)).toEqual(['step 1 (The pin): `await:` differs'])
  })

  it('catches a `{view}` line dropped from the prose', () => {
    const unplaced = parseTour(FRENCH.replace('{watch}\n\n', ''))
    expect(mismatches(source, unplaced)).toEqual([
      'step 1 (The pin): `{view} lines in the prose` differs',
    ])
  })

  it('catches front matter that differs', () => {
    const elsewhere = parseTour(FRENCH.replace('next: basic_button', 'next: philosophers'))
    expect(mismatches(source, elsewhere)).toEqual(['front matter `next:` differs'])
  })

  it('catches a step or a section missing', () => {
    // The parser's own complaint about it (`next:` needs an outro) comes too.
    const short = parseTour(FRENCH.slice(0, FRENCH.indexOf('## Terminé')))
    expect(mismatches(source, short)[0]).toBe('the closing section is missing')
    const noIntro = parseTour(FRENCH.replace('De quoi parle cette visite.\n', ''))
    expect(mismatches(source, noIntro)).toEqual(['the introduction is missing'])
  })
})

describe('pickTranslation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('runs a translation that lines up', () => {
    const french = parseTour(FRENCH)
    expect(pickTranslation(parseTour(SOURCE), french, 'tours/fr/x.tour.md')).toBe(french)
  })

  it('runs the English tour instead of one that does not, and says why', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = parseTour(SOURCE)
    const moved = parseTour(FRENCH.replace('/gpio_pin_toggle_dt/', '/k_msleep/'))
    expect(pickTranslation(source, moved, 'tours/fr/x.tour.md')).toBe(source)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tours/fr/x.tour.md'))
  })
})

describe('loadLocalizedTour', () => {
  it('loads the translation in a language that has one', async () => {
    const english = await loadLocalizedTour('blinky', 'en')
    const french = await loadLocalizedTour('blinky', 'fr')
    expect(french?.title).toBe(parseTour(read('fr', 'blinky.tour.md')).title)
    expect(french?.title).not.toBe(english?.title)
  })

  it('falls back to English where there is none', async () => {
    const english = await loadLocalizedTour('blinky', 'en')
    expect((await loadLocalizedTour('blinky', 'de'))?.title).toBe(english?.title)
    expect((await loadLocalizedTour('philosophers', 'fr'))?.title).toBe(
      parseTour(read('philosophers.tour.md')).title,
    )
  })

  it('reads a tour that does not exist as none', async () => {
    expect(await loadLocalizedTour('blinky.gone', 'fr')).toBeNull()
  })
})
