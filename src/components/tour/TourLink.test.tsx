import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CopyTourLink, StartedAt, startedAt } from './TourLink'

describe('startedAt', () => {
  it('says nothing about a tour taken from the top', () => {
    expect(startedAt({ startIndex: 0, seen: new Set() }, 0)).toBeNull()
    expect(startedAt({ startIndex: 0, seen: new Set([0]) }, 0)).toBeNull()
  })

  it('says where a link started the tour, on the first card the reader sees', () => {
    // The your-turn card for the first step, before any card has been up.
    expect(startedAt({ startIndex: 2, seen: new Set() }, 2)).toBe(3)
    // That step's own card, and the same card read again later.
    expect(startedAt({ startIndex: 2, seen: new Set([2]) }, 2)).toBe(3)
    expect(startedAt({ startIndex: 2, seen: new Set([2, 3]) }, 2)).toBe(3)
    // Any card after it.
    expect(startedAt({ startIndex: 2, seen: new Set([2, 3]) }, 3)).toBeNull()
  })
})

describe('StartedAt', () => {
  it('names the step, and says what starting there skipped', () => {
    const html = renderToStaticMarkup(<StartedAt step={3} />)
    expect(html.replace(/<[^>]+>/g, '')).toBe('Started at step 3')
    expect(html).toContain('The steps before this one were skipped.')
  })
})

describe('CopyTourLink', () => {
  it('is a labelled button, not a bare icon', () => {
    const html = renderToStaticMarkup(
      <CopyTourLink boardId="qemu_cortex_a53" sampleId="blinky" tourId="blinky" step={2} />,
    )
    expect(html).toContain('aria-label="Copy a link to this step"')
    expect(html).toContain('title="Copy a link that opens this tour at this step"')
  })
})
