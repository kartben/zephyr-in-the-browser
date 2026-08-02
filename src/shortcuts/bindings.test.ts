/**
 * Keeps the help-dialog registry and the installed handlers from drifting:
 * every SHORTCUTS id must be wired in bindings.ts, and every onShortcut call
 * must name a known id.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from '@/lib/shortcuts'

const here = dirname(fileURLToPath(import.meta.url))
const bindingsSrc = readFileSync(resolve(here, 'bindings.ts'), 'utf8')

describe('shortcut bindings coverage', () => {
  const wired = [...bindingsSrc.matchAll(/onShortcut\(\s*'([^']+)'/g)].map((m) => m[1]!)

  it('wires every registered shortcut id', () => {
    const missing = SHORTCUTS.map((s) => s.id).filter((id) => !wired.includes(id))
    expect(missing, `unwired shortcut ids: ${missing.join(', ')}`).toEqual([])
  })

  it('does not wire unknown shortcut ids', () => {
    const known = new Set(SHORTCUTS.map((s) => s.id))
    const unknown = wired.filter((id) => !known.has(id))
    expect(unknown, `unknown onShortcut ids: ${unknown.join(', ')}`).toEqual([])
  })

  it('wires each id exactly once', () => {
    const counts = new Map<string, number>()
    for (const id of wired) counts.set(id, (counts.get(id) ?? 0) + 1)
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
    expect(dupes, `duplicate onShortcut ids: ${dupes.join(', ')}`).toEqual([])
  })
})
