import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/Markdown'

describe('Markdown', () => {
  it('draws a ```mermaid block as a diagram, not as code', () => {
    const html = renderToStaticMarkup(
      <Markdown body={'Before.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\nAfter.'} />,
    )
    // Mermaid loads in an effect, which a static render never runs.
    expect(html).toContain('data-tour-diagram="drawing"')
    expect(html).not.toContain('<pre')
    expect(html.indexOf('Before.')).toBeLessThan(html.indexOf('data-tour-diagram'))
    expect(html.indexOf('data-tour-diagram')).toBeLessThan(html.indexOf('After.'))
  })

  it('still shows other fences as code', () => {
    const html = renderToStaticMarkup(<Markdown body={'```c\nint x;\n```'} />)
    expect(html).toContain('<pre')
    expect(html).not.toContain('data-tour-diagram')
  })
})
