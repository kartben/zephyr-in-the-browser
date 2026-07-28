import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HexView } from './HexView'
import { createAt24 } from '@/virtio/devices/memory/at24'

/**
 * The dump is what a user actually reads off this panel, so pin its content:
 * the right bytes at the right offsets, and an ASCII gutter that agrees with
 * them. Rendered statically — the live parts (change flash, pointer tracking)
 * run in effects and are covered by the model's own tests.
 */
function render(chip: ReturnType<typeof createAt24>) {
  const html = renderToStaticMarkup(<HexView chip={chip} />)
  // Strip tags so assertions read against the visible text, not the markup.
  return html.replace(/<[^>]+>/g, '')
}

describe('HexView', () => {
  it('lays a 256-byte part out as 16 rows of 16 bytes', () => {
    const text = render(createAt24())
    // Offset gutter: first row, last row, and one in between.
    expect(text).toContain('0000')
    expect(text).toContain('0080')
    expect(text).toContain('00f0')
    expect(text).not.toContain('0100')
  })

  it('shows written bytes in hex alongside their ASCII', () => {
    const chip = createAt24()
    // "Hi" at offset 0, then a non-printable byte.
    chip.write(Uint8Array.of(0x00, 0x48, 0x69, 0x01))
    const text = render(chip)

    expect(text).toContain('486901')
    // Printable bytes appear as themselves; the 0x01 falls back to a dot.
    expect(text).toContain('Hi·')
  })

  it('renders erased cells as ff, so a blank part reads as blank', () => {
    const text = render(createAt24())
    expect(text).toContain('ff'.repeat(16))
    // An erased part has no printable ASCII at all.
    expect(text).toContain('·'.repeat(16))
  })

  it('follows a poke from the page', () => {
    const chip = createAt24()
    chip.poke(0x00, 0x5a)
    expect(render(chip)).toContain('5aff')
  })

  it('offers every ASCII glyph as an edit target, not just the hex column', () => {
    const chip = createAt24()
    chip.write(Uint8Array.of(0x00, 0x48, 0x69))
    const html = renderToStaticMarkup(<HexView chip={chip} addressBase={0x20000000} />)

    // Both columns address the same byte, so either can be typed into.
    expect(html).toContain('title="0x20000001 — click to edit"')
    expect(html).toContain('title="0x20000001 — click to type a character"')
    // The glyph is still what it was; only the affordance is new.
    expect(html.replace(/<[^>]+>/g, '')).toContain('Hi·')
  })

  it('shifts gutter labels by addressBase', () => {
    const chip = createAt24()
    const html = renderToStaticMarkup(<HexView chip={chip} addressBase={0x20000000} />)
    const text = html.replace(/<[^>]+>/g, '')
    expect(text).toContain('20000000')
    expect(text).toContain('200000f0')
  })
})
