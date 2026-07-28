import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOARDS, withA53TraceVariants } from './boards'
import type { GuestSample } from './boards'

/**
 * Every gallery entry needs a packaged ELF. The build only emits what
 * tools/samples.manifest lists (plus A53 `_trace` twins from the same
 * expansion as withA53TraceVariants), so boards.ts and the manifest must stay
 * in lockstep — otherwise the UI offers samples the release never ships.
 */

/** Same set as BUILTIN_TRACE_IDS in tools/build-zephyr-image.sh. */
const BUILTIN_TRACE_IDS = new Set(['tracing', 'tracing_pipeline'])

function parseManifestBase(): Map<string, Set<string>> {
  const text = readFileSync(resolve(process.cwd(), 'tools/samples.manifest'), 'utf8')
  const byBoard = new Map<string, Set<string>>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [board, app] = trimmed.split(':')
    if (!board || !app) continue
    let apps = byBoard.get(board)
    if (!apps) {
      apps = new Set()
      byBoard.set(board, apps)
    }
    apps.add(app)
  }
  return byBoard
}

/** Mirror expand_trace_variants in tools/build-zephyr-image.sh. */
function expandManifest(base: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [board, apps] of base) {
    const expanded = new Set(apps)
    if (board === 'qemu_cortex_a53') {
      for (const id of apps) {
        if (BUILTIN_TRACE_IDS.has(id) || id.endsWith('_trace')) continue
        expanded.add(`${id}_trace`)
      }
    }
    out.set(board, expanded)
  }
  return out
}

describe('samples.manifest ↔ boards.ts', () => {
  const manifest = expandManifest(parseManifestBase())

  it('packages every sample the UI lists', () => {
    const missing: string[] = []
    for (const board of BOARDS) {
      const apps = manifest.get(board.zephyrTarget)
      for (const sample of board.samples) {
        if (!apps?.has(sample.id)) {
          missing.push(`${board.zephyrTarget}:${sample.id}`)
        }
      }
    }
    expect(missing, 'add these lines to tools/samples.manifest').toEqual([])
  })

  it('does not package samples the UI does not list', () => {
    const ui = new Map(BOARDS.map((b) => [b.zephyrTarget, new Set(b.samples.map((s) => s.id))]))
    const extra: string[] = []
    for (const [board, apps] of manifest) {
      const listed = ui.get(board)
      for (const app of apps) {
        if (!listed?.has(app)) extra.push(`${board}:${app}`)
      }
    }
    expect(extra, 'drop these from tools/samples.manifest, or add them to boards.ts').toEqual([])
  })
})

describe('withA53TraceVariants', () => {
  const base: GuestSample[] = [
    {
      id: 'blinky',
      label: 'Blinky',
      description: 'Blinks',
      zephyrSample: 'samples/basic/blinky',
      primaryPanels: ['led'],
    },
    {
      id: 'tracing',
      label: 'Tracing',
      description: 'CTF',
      zephyrSample: 'samples/subsys/tracing/basic',
      primaryPanels: ['trace'],
    },
  ]

  it('adds a _trace twin with Trace + Debug panels', () => {
    const expanded = withA53TraceVariants(base)
    expect(expanded.map((s) => s.id)).toEqual(['blinky', 'blinky_trace', 'tracing'])
    const twin = expanded.find((s) => s.id === 'blinky_trace')!
    expect(twin.tracedFrom).toBe('blinky')
    expect(twin.primaryPanels).toEqual(['led', 'trace', 'debug'])
  })

  it('skips samples that already embed CTF in prj.conf', () => {
    const expanded = withA53TraceVariants(base)
    expect(expanded.some((s) => s.id === 'tracing_trace')).toBe(false)
  })
})
