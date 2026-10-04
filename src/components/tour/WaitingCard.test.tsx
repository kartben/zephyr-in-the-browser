import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { parseTour } from '@/tours/parse'
import { WaitingCard } from './WaitingCard'

vi.mock('@/tours/store', () => ({ skip: vi.fn(), revisit: vi.fn() }))

const { steps } = parseTour(
  ['One', 'Two', 'Three']
    .map((title) => `## ${title}\n\n\`\`\`tour\nat: main\n\`\`\`\n\nProse.\n`)
    .join('\n'),
)

function render(text: string, lines: string[], notes: string[] = []) {
  const html = renderToStaticMarkup(
    <WaitingCard waiting={{ index: 1, text, do: lines, notes }} steps={steps} seen={new Set([0])} />,
  )
  // Strip tags so assertions read against the visible text, not the markup.
  return { html, text: html.replace(/<[^>]+>/g, '') }
}

describe('WaitingCard', () => {
  it('says what to do, for which step, and how to get out', () => {
    const { html, text } = render('Press **SW0** in the dock.', [])
    expect(text).toContain('your turn')
    expect(text).toContain('2/3')
    expect(html).toContain('<strong class="font-semibold text-foreground">SW0</strong>')
    expect(text).toContain('The tour picks up at the next stop.')
    expect(text).toContain('Leave the tour')
    // Nothing to type, so no snippet to run.
    expect(html).not.toContain('data-language="shell"')
  })

  it('shows the shell lines as one snippet to run or copy, in order', () => {
    const { html, text } = render('Stop the consumer.', ['msgq consumer suspend', 'msgq stat'])
    expect(html).toContain('data-language="shell"')
    expect(html).toContain('msgq consumer suspend\nmsgq stat')
    // The guest runs on under this card, so it is Run, never Continue and run.
    expect(text).toContain('Run')
    expect(text).not.toContain('Continue and run')
    expect(text).toContain('Copy')
  })

  it('says when a view the step points at cannot open on this build', () => {
    const note = 'This view needs the traced build of this sample.'
    expect(render('Watch the queue fill.', [], [note]).text).toContain(note)
    expect(render('Watch the queue fill.', []).text).not.toContain(note)
  })
})
