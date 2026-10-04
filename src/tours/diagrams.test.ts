// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unknownDiagramClasses } from '@/tours/diagram'

/**
 * A ```mermaid block that does not parse draws as its source on the card, with
 * an error under it, and nothing else notices. So every diagram in a shipped
 * tour is parsed here, the way a misspelt directive key fails the tour parser.
 *
 * Mermaid sanitises labels as it parses, through DOMPurify, which needs a DOM:
 * hence happy-dom for this file alone.
 */

const TOURS_DIR = resolve(process.cwd(), 'tours')

function diagrams(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = []
  for (const file of readdirSync(TOURS_DIR).filter((f) => f.endsWith('.tour.md')).sort()) {
    const text = readFileSync(join(TOURS_DIR, file), 'utf8')
    for (const m of text.matchAll(/^```mermaid[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)) {
      out.push({ file, source: m[1]! })
    }
  }
  return out
}

describe('tour diagrams', () => {
  const found = diagrams()

  it.each(found.map((d) => [d.file, d.source] as const))('%s: a diagram parses', async (_file, source) => {
    const { default: mermaid } = await import('mermaid')
    await expect(mermaid.parse(source)).resolves.toBeTruthy()
  })

  it.each(found.map((d) => [d.file, d.source] as const))(
    '%s: a diagram uses only classes that are defined',
    (_file, source) => {
      expect(unknownDiagramClasses(source)).toEqual([])
    },
  )

  it('rejects a diagram that does not parse', async () => {
    const { default: mermaid } = await import('mermaid')
    await expect(mermaid.parse('flowchart LR\n  a -->')).rejects.toThrow(/Parse error/)
  })
})
