import { describe, expect, it } from 'vitest'

import { fitLabels, labelWidth, type HexNoteLabel } from './hexNotes'

const note = (head: string, rank = 0, extra: Partial<HexNoteLabel> = {}) => ({
  label: { head, ...extra },
  rank,
})

describe('labelWidth', () => {
  it('counts the badge pill and the role as well as the name', () => {
    expect(labelWidth({ head: 'shell_uart' })).toBe(10)
    // `k_sem`, a character of padding either side, and the gap after it.
    expect(labelWidth({ badge: 'k_sem', head: 'fork', tail: '[1]' })).toBe(8 + 4 + 3)
    expect(labelWidth({ role: '.wait_q', head: 'empty' })).toBe(8 + 5)
  })
})

describe('fitLabels', () => {
  it('shows everything that fits, in byte order', () => {
    const notes = [note('aaaa'), note('bbbb'), note('cccc')]
    expect(fitLabels(notes, 40).shown).toEqual(notes)
    expect(fitLabels(notes, 40).hidden).toEqual([])
  })

  it('always shows one label, even in a column too narrow for it', () => {
    const { shown, hidden } = fitLabels([note('a_very_long_symbol_name')], 5)
    expect(shown.map((n) => n.label.head)).toEqual(['a_very_long_symbol_name'])
    expect(hidden).toEqual([])
  })

  it('keeps the most important label and counts the rest', () => {
    // A type descriptor (rank 3) first in the row, a waiting thread (rank 0)
    // after it: the thread wins the only slot.
    const notes = [note('obj_type_sem', 3), note('shell_uart', 0)]
    const { shown, hidden } = fitLabels(notes, 14)
    expect(shown.map((n) => n.label.head)).toEqual(['shell_uart'])
    expect(hidden.map((n) => n.label.head)).toEqual(['obj_type_sem'])
  })

  it('lists winners in byte order, not rank order', () => {
    const notes = [note('first', 2), note('second', 0), note('third', 1)]
    expect(fitLabels(notes, 80).shown.map((n) => n.label.head)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('leaves room for the "n more" that says something was dropped', () => {
    // 5 + 2 + 5 = 12 fits, but not with "1 more" (and its gap) after it.
    const notes = [note('aaaaa'), note('bbbbb'), note('cccccccccc')]
    expect(fitLabels(notes, 12).shown).toHaveLength(1)
    expect(fitLabels(notes, 20).shown).toHaveLength(2)
    expect(fitLabels(notes, 24).shown).toHaveLength(3)
  })

  it('ignores notes without a label', () => {
    const bare: { label?: HexNoteLabel; rank: number } = { rank: 0 }
    expect(fitLabels([bare, note('x')], 10).shown.map((n) => n.label?.head)).toEqual(['x'])
  })
})
