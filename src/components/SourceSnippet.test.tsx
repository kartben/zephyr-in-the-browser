// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SourceSnippet } from '@/components/SourceSnippet'

// React only flushes `act()` updates synchronously when told it is under test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/*
 * The sensor pipeline's shape: a stop deep in the file (207) and a one-line
 * highlight far above it (85), too far apart to share a window.
 */
const FILE = Array.from({ length: 332 }, (_, i) => `int line_${i + 1};`).join('\n')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

/** Source line numbers on screen, in order. */
function shownLines(): number[] {
  return [...host.querySelectorAll<HTMLElement>('[data-line]')].map((row) => Number(row.dataset.line))
}

/** The button whose visible label is `label`, ignoring decoration hidden from assistive tech. */
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => accessibleText(b) === label)
  if (!found) throw new Error(`no "${label}" button in: ${host.textContent}`)
  return found
}

function accessibleText(el: Element): string {
  return [...el.childNodes]
    .map((node) =>
      node instanceof Element
        ? node.getAttribute('aria-hidden') === 'true'
          ? ''
          : accessibleText(node)
        : (node.textContent ?? ''),
    )
    .join('')
    .trim()
}

/** Gutter tooltips on the rows: what the stop marker says about the machine. */
function stopTitles(): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-line] > span[title]')].map((s) => s.title)
}

describe('SourceSnippet', () => {
  it('folds the lines between two far runs into a button that opens and shuts them in place', () => {
    render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} />)
    const folded = [82, 83, 84, 85, 86, 87, 88, 204, 205, 206, 207, 208, 209, 210]
    expect(shownLines()).toEqual(folded)

    const fold = button('Show lines 89 to 203')
    expect(fold.getAttribute('type')).toBe('button')
    expect(fold.getAttribute('aria-expanded')).toBe('false')

    act(() => fold.click())
    expect(shownLines()).toEqual(Array.from({ length: 210 - 82 + 1 }, (_, i) => 82 + i))
    // The same row, so focus stays on it, now offering the way back.
    expect(button('Hide lines 89 to 203')).toBe(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')

    act(() => fold.click())
    expect(shownLines()).toEqual(folded)
    expect(fold.getAttribute('aria-expanded')).toBe('false')
  })

  it('marks where a paused step stopped, and says so in the tense the machine is in', () => {
    render(<SourceSnippet text={FILE} line={207} />)
    expect(stopTitles()).toEqual(['the machine is stopped here'])
    expect(host.querySelector('[data-line="207"]')?.textContent).toContain('▸')

    // The same step read again: it stopped there once, and the guest moved on.
    render(<SourceSnippet text={FILE} line={207} stop="earlier" />)
    expect(stopTitles()).toEqual(['the machine stopped here on this step'])
  })

  it('folds a running step to one row, and never claims a stop when it opens', () => {
    render(<SourceSnippet text={FILE} line={207} stop="none" label="main.c:207" />)
    expect(host.querySelector('pre')).toBeNull()
    const row = button('Show main.c:207')
    expect(row.getAttribute('aria-expanded')).toBe('false')

    act(() => row.click())
    expect(shownLines()).toEqual([204, 205, 206, 207, 208, 209, 210])
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(accessibleText(row)).toBe('Hide main.c:207')
    // No marker, no tooltip saying the machine is stopped, no stop tint.
    expect(stopTitles()).toEqual([])
    expect(host.textContent).not.toContain('▸')
    expect(host.querySelector('[data-line="207"]')?.className).not.toContain('bg-primary')

    act(() => row.click())
    expect(host.querySelector('pre')).toBeNull()
  })

  it('names a running step by its file and line when the card gives no label', () => {
    render(<SourceSnippet text={FILE} line={12} stop="none" filename="main.c" />)
    expect(button('Show main.c:12')).toBeTruthy()
  })

  it('keeps the highlight tint on a running step once it is open', () => {
    render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 209, end: 209 }]} stop="none" label="main.c:207" />)
    act(() => button('Show main.c:207').click())
    expect(host.querySelector('[data-line="209"]')?.className).toContain('bg-amber')
  })
})
