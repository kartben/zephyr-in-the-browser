import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOARDS } from './boards'

/**
 * Every gallery entry needs a packaged ELF. The build only emits what
 * tools/samples.manifest lists, so boards.ts and the manifest must stay in
 * lockstep — otherwise the UI offers samples the release never ships
 * (see the tracing commit that dropped oled and the A53 net samples).
 */
function parseManifest(): Map<string, Set<string>> {
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

describe('samples.manifest ↔ boards.ts', () => {
  const manifest = parseManifest()

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
