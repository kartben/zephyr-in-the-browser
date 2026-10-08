import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * tools/docs-widget/widget.js runs on the mirrored docs pages, outside the
 * page bundle, so it is run here the way such a page runs it: a plain script
 * reading `window.ZEPHYR_SIM`. The DOM is faked down to what its "Run in
 * simulator" button needs.
 */
const WIDGET = readFileSync(resolve(process.cwd(), 'tools/docs-widget/widget.js'), 'utf8')

/** Where the widget's button points on a page configured with `cfg`. */
function runHref(cfg: Record<string, unknown>): string {
  const made: Array<Record<string, unknown>> = []
  const body = { querySelector: () => null }
  const document = {
    readyState: 'complete',
    body,
    querySelector: () => body,
    createTextNode: () => ({}),
    createElement: () => {
      const element = { appendChild: () => {}, addEventListener: () => {} }
      made.push(element)
      return element
    },
  }
  runInNewContext(WIDGET, { window: { ZEPHYR_SIM: cfg }, document })
  return made[0]!.href as string
}

const CFG = { app: 'basic_button', board: 'qemu_cortex_m3', simRoot: '../../../' }

describe('docs widget', () => {
  it('opens the sample on its board', () => {
    expect(runHref(CFG)).toBe('../../../?board=qemu_cortex_m3&app=basic_button')
  })

  it('forwards the tour it is given', () => {
    expect(runHref({ ...CFG, tour: 'basic_button.msgq' })).toBe(
      '../../../?board=qemu_cortex_m3&app=basic_button&tour=basic_button.msgq',
    )
  })
})
