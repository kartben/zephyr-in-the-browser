// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SourceSnippet } from '@/components/SourceSnippet'

// React only flushes `act()` updates synchronously when told it is under test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/*
 * The sensor pipeline's shape: a stop deep in the file (207) and a one-line
 * highlight far above it (85), too far apart to open in one view.
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

/** Source line numbers in the listing, in order, leaving out any pinned copy. */
function shownLines(): number[] {
  return [...host.querySelectorAll<HTMLElement>('pre [data-line]')].map((row) => Number(row.dataset.line))
}

const WHOLE_FILE = Array.from({ length: 332 }, (_, i) => i + 1)

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
  return [...host.querySelectorAll<HTMLElement>('pre [data-line] > span[title]')].map((s) => s.title)
}

describe('SourceSnippet', () => {
  it('lays out the whole file, with nothing folded away', () => {
    render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} filename="main.c" />)
    expect(shownLines()).toEqual(WHOLE_FILE)
    expect(button('main.c')).toBeTruthy()
    expect(host.textContent).not.toContain('Show lines')
  })

  it('does not count a trailing newline as a line', () => {
    render(<SourceSnippet text={'int a;\nint b;\n'} line={1} />)
    expect(shownLines()).toEqual([1, 2])
  })

  it('marks the highlight and the stop differently, wherever they are in the file', () => {
    render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} />)
    expect(host.querySelector('pre [data-line="85"]')?.className).toContain('code-row-mark')
    expect(host.querySelector('pre [data-line="207"]')?.className).toContain('code-row-stop')
    expect(host.querySelector('pre [data-line="86"]')?.className).not.toContain('code-row-mark')
  })

  describe('with a real window', () => {
    // happy-dom lays nothing out: give the scroller the 16 rows it would have.
    const ROW = 18
    let restore: (() => void)[] = []
    const fake = (prop: 'clientHeight' | 'scrollHeight', value: number) => {
      const had = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value })
      restore.push(() => {
        if (had) Object.defineProperty(HTMLElement.prototype, prop, had)
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
      })
    }
    beforeEach(() => {
      fake('clientHeight', 16 * ROW)
      fake('scrollHeight', 332 * ROW)
    })
    afterEach(() => {
      restore.forEach((undo) => undo())
      restore = []
    })

    const scroller = () => host.querySelector<HTMLElement>('[role="region"]')!
    const pinned = (edge: 'top' | 'bottom') =>
      [...host.querySelectorAll<HTMLElement>(`[data-pins="${edge}"] [data-line]`)].map((row) =>
        Number(row.dataset.line),
      )
    const scrollTo = (line: number) =>
      act(() => {
        scroller().scrollTop = (line - 1) * ROW
        scroller().dispatchEvent(new Event('scroll', { bubbles: true }))
      })

    it('opens with the far highlight pinned, with the lines around it', () => {
      render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} />)
      expect(pinned('top')).toEqual([84, 85, 86])
      expect(pinned('bottom')).toEqual([])
      expect(host.querySelector('[data-pins="top"] [data-line="85"]')?.className).toContain('code-row-mark')
    })

    it('moves the pins as the reader scrolls, and goes back to a line when pressed', () => {
      render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} />)
      scrollTo(1)
      expect(pinned('top')).toEqual([])
      expect(pinned('bottom')).toEqual([84, 85, 86, 206, 207, 208])

      scrollTo(260)
      expect(pinned('top')).toEqual([84, 85, 86, 206, 207, 208])
      expect(host.querySelectorAll('[data-pins="top"] [aria-hidden="true"]').length).toBe(2)

      act(() => host.querySelector<HTMLElement>('[aria-label="Go to line 207"]')!.click())
      expect(scroller().scrollTop).toBe(206 * ROW - (16 * ROW) / 2 + ROW / 2)
      expect(document.activeElement).toBe(scroller())
    })

    it('takes the wheel over a pinned line, and leaves it to the page at the end of the file', () => {
      render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} />)
      scrollTo(120)
      const wheel = (deltaY: number) => {
        const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
        act(() => {
          host.querySelector('[data-pins="top"] [data-line="85"]')!.dispatchEvent(event)
        })
        return event
      }
      const before = scroller().scrollTop
      expect(wheel(90).defaultPrevented).toBe(true)
      expect(scroller().scrollTop).toBe(before + 90)

      scrollTo(332 - 16 + 1)
      expect(wheel(90).defaultPrevented).toBe(false)
    })

    it('pages by the code the pins leave free', () => {
      render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} />)
      scrollTo(120)
      const before = scroller().scrollTop
      act(() => {
        scroller().dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))
      })
      const moved = scroller().scrollTop - before
      expect(moved).toBeGreaterThan(0)
      // Pins cover 3 rows and a break at each edge, out of 16.
      expect(moved).toBeLessThan((16 - 6) * ROW)
    })

    it('pins nothing in the popup, wherever it is scrolled', () => {
      render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} filename="main.c" />)
      expect(pinned('top')).toEqual([84, 85, 86])

      act(() => button('main.c').click())
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
      const list = dialog.querySelector<HTMLElement>('[role="region"]')!
      for (const line of [1, 120, 260]) {
        act(() => {
          list.scrollTop = (line - 1) * ROW
          list.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        expect(dialog.querySelector('[data-pins]')).toBeNull()
      }
      act(() => dialog.querySelector<HTMLElement>('[aria-label="Close"]')!.click())
    })

    it('keeps the height the reader picked for the next step', () => {
      render(<SourceSnippet key={1} text={FILE} line={207} />)
      const grip = () => host.querySelector<HTMLElement>('[role="separator"]')!
      const height = () => Number(grip().getAttribute('aria-valuenow'))
      const before = height()
      act(() => {
        grip().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
      expect(height()).toBe(before + ROW)

      render(<SourceSnippet key={2} text={FILE} line={154} />)
      expect(height()).toBe(before + ROW)
    })
  })

  it('opens the whole file in a popup from its name, keeping the marks', () => {
    render(<SourceSnippet text={FILE} line={207} ranges={[{ start: 85, end: 85 }]} filename="main.c" />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    act(() => button('main.c').click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelector('h2')?.textContent).toBe('main.c')
    expect(dialog.querySelectorAll('pre [data-line]')).toHaveLength(332)
    expect(dialog.querySelector('pre [data-line="85"]')?.className).toContain('code-row-mark')
    expect(dialog.querySelector('pre [data-line="207"]')?.className).toContain('code-row-stop')
    // It fills the popup: there is no height to pick.
    expect(dialog.querySelector('[role="separator"]')).toBeNull()

    act(() => dialog.querySelector<HTMLElement>('[aria-label="Close"]')!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('offers the file on a running step too, without opening its code in the card', () => {
    render(<SourceSnippet text={FILE} line={207} stop="none" label="main.c:207" filename="main.c" />)
    expect(host.querySelector('pre')).toBeNull()
    act(() => button('main.c').click())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelectorAll('pre [data-line]')).toHaveLength(332)
    // No stop to claim here either.
    expect(dialog.textContent).not.toContain('▸')
    act(() => dialog.querySelector<HTMLElement>('[aria-label="Close"]')!.click())
    expect(host.querySelector('pre')).toBeNull()
  })

  it('marks where a paused step stopped, and says so in the tense the machine is in', () => {
    render(<SourceSnippet text={FILE} line={207} />)
    expect(stopTitles()).toEqual(['the machine is stopped here'])
    expect(host.querySelector('pre [data-line="207"]')?.textContent).toContain('▸')

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
    expect(shownLines()).toEqual(WHOLE_FILE)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(accessibleText(row)).toBe('Hide main.c:207')
    // No marker, no tooltip saying the machine is stopped, no stop tint.
    expect(stopTitles()).toEqual([])
    expect(host.textContent).not.toContain('▸')
    expect(host.querySelector('pre [data-line="207"]')?.className).not.toContain('code-row-stop')

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
    expect(host.querySelector('pre [data-line="209"]')?.className).toContain('code-row-mark')
  })
})
