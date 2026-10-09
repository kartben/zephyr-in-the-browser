/**
 * How far each translation has got: the page's strings (src/locales/<lang>.json)
 * and the tours (tours/<lang>/). Untranslated strings and tours show in
 * English on the page, so this is a to-do list, not a gate; the tests check
 * that what has been translated is right (src/i18n/locales.test.ts,
 * src/tours/translations.test.ts).
 *
 *   npm run i18n:status        every language, one line each
 *   npm run i18n:status fr     French, with what is left to translate
 *
 * A plural counts once, whatever its forms.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = join(root, 'src/locales')
const toursDir = join(root, 'tours')
const PLURAL = /_(zero|one|two|few|many|other)$/

/** Every string key of a locale file, dotted, with plural forms folded into one. */
function keys(code) {
  const out = new Set()
  const walk = (tree, prefix) => {
    for (const [key, value] of Object.entries(tree)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'string') {
        if (value !== '') out.add(path.replace(PLURAL, ''))
      } else walk(value, path)
    }
  }
  walk(JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8')), '')
  return out
}

const sourceTours = readdirSync(toursDir)
  .filter((f) => f.endsWith('.tour.md'))
  .map((f) => f.replace('.tour.md', ''))
  .sort()
const english = keys('en')
const only = process.argv[2]
const codes = readdirSync(localesDir)
  .filter((f) => f.endsWith('.json') && f !== 'en.json')
  .map((f) => f.replace('.json', ''))
  .filter((code) => !only || code === only)
  .sort()

if (only && codes.length === 0) {
  console.error(`No src/locales/${only}.json. To start a language, copy src/locales/en.json there.`)
  process.exit(1)
}

const pct = (n, of) => `${String(Math.floor((100 * n) / of)).padStart(3)}%`

for (const code of codes) {
  const have = keys(code)
  const missing = [...english].filter((key) => !have.has(key))
  const dir = join(toursDir, code)
  const translated =
    existsSync(dir) && statSync(dir).isDirectory()
      ? sourceTours.filter((id) => existsSync(join(dir, `${id}.tour.md`)))
      : []
  const strings = english.size - missing.length
  console.log(
    `${code.padEnd(8)} strings ${String(strings).padStart(4)}/${english.size} ${pct(strings, english.size)}` +
      `   tours ${String(translated.length).padStart(3)}/${sourceTours.length} ${pct(translated.length, sourceTours.length)}`,
  )
  if (!only) continue
  if (missing.length > 0) {
    console.log(`\nStrings left in src/locales/${code}.json:`)
    for (const key of missing) console.log(`  ${key}`)
  }
  const untranslated = sourceTours.filter((id) => !translated.includes(id))
  if (untranslated.length > 0) {
    console.log(`\nTours left (copy tours/<id>.tour.md to tours/${code}/<id>.tour.md):`)
    for (const id of untranslated) console.log(`  ${id}`)
  }
}
