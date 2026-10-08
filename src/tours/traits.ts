/**
 * What a tour needs from the build it runs on, known before the tour loads.
 *
 * The page has to pick a build before it boots: a tour that points at Trace
 * runs on the sample's traced twin, and a board without one does not offer it.
 * The tours themselves stay lazy chunks (src/tours/catalog.ts), so the build
 * reads each one here and hands the page a boolean per file instead:
 *
 *     import.meta.glob('/tours/*.tour.md', { query: '?needs-trace', eager: true })
 *
 * Node-only: vite.config.ts and vitest.config.ts register the plugin, and the
 * page imports nothing from this file.
 */

import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

/** The query that turns a tour file into `export default <needs trace>`. */
export const NEEDS_TRACE_QUERY = 'needs-trace'

/** A `look:` target inside Trace, or the Trace row named as a dock row. */
function isTraceLook(target: string): boolean {
  return target.startsWith('trace.') || target === 'dock.trace'
}

/**
 * True when any step points at Trace: a `look: trace.<tab>`, a
 * `look: dock.trace`, or `panel: trace` (`reveal:`, its older spelling).
 *
 * A line scan of the ```tour blocks rather than src/tours/parse.ts, which this
 * build-time file cannot load. catalog.test.ts holds the two to the same
 * answer for every tour in the repository.
 */
export function tourNeedsTrace(markdown: string): boolean {
  let inTour = false
  let key: string | null = null
  const hit = (k: string | null, value: string) => {
    const v = value.trim()
    if (v === '') return false
    if (k === 'look') return isTraceLook(v)
    if (k === 'panel' || k === 'reveal') return v === 'trace'
    return false
  }
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inTour = !inTour && /^\s*(```|~~~)\s*tour\s*$/.test(line)
      key = null
      continue
    }
    if (!inTour) continue
    const directive = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (directive) {
      key = directive[1]!
      if (directive[2]!.split(',').some((v) => hit(key, v))) return true
      continue
    }
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && hit(key, item[1]!)) return true
  }
  return false
}

/** Serves `<tour>.tour.md?needs-trace` as a module whose default is that boolean. */
export function tourTraits(): Plugin {
  return {
    name: 'zephyr-tour-traits',
    enforce: 'pre',
    load(id) {
      const [file, query] = id.split('?')
      if (query !== NEEDS_TRACE_QUERY || !file!.endsWith('.tour.md')) return null
      this.addWatchFile(file!)
      return `export default ${tourNeedsTrace(readFileSync(file!, 'utf8'))}`
    },
  }
}
