import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Board } from '@/boards'
import { CompletionCard } from './CompletionCard'

vi.mock('@/tours/store', () => ({
  dismissCompletion: vi.fn(),
  fetchTour: vi.fn(async () => null),
}))

const OUTRO = { title: 'What you saw', body: 'A message queue is a *ring* of fixed-size slots.' }

/** Only the app list matters here: where Next can go, and what it is called. */
function board(...ids: string[]): Board {
  const labels: Record<string, string> = { msg_queue: 'Message queue', msgq_lab: 'Message queue lab' }
  return { samples: ids.map((id) => ({ id, label: labels[id] ?? id })) } as unknown as Board
}

function render(next: string | null, nextTitle: string | null, on = board('msg_queue', 'msgq_lab')) {
  const html = renderToStaticMarkup(
    <CompletionCard board={on} sampleId="msg_queue" outro={OUTRO} next={next} nextTitle={nextTitle} />,
  )
  // Strip tags so assertions read against the visible text, not the markup.
  return { html, text: html.replace(/<[^>]+>/g, '') }
}

describe('CompletionCard', () => {
  it('ends on the outro, with a way to take the tour again', () => {
    const { html, text } = render(null, null)
    expect(text).toContain('Tour complete')
    expect(text).toContain('What you saw')
    expect(html).toContain('<em class="italic">ring</em>')
    expect(text).toContain('Run it again')
    expect(html).toContain('aria-label="Close"')
    expect(text).not.toContain('Next')
  })

  it('offers the next tour by its title', () => {
    const { text } = render('msgq_lab', 'Message queues, part 2: the lab')
    expect(text).toContain('Next: Message queues, part 2: the lab')
    expect(text).toContain('Run it again')
  })

  it('names the app until the next tour has loaded', () => {
    expect(render('msgq_lab', null).text).toContain('Next: Message queue lab')
  })

  it('offers no way on when this board does not have the next app', () => {
    const { text } = render('msgq_lab', 'Message queues, part 2', board('msg_queue'))
    expect(text).not.toContain('Next')
    expect(text).toContain('Run it again')
  })
})
