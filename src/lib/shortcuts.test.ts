import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchShortcut,
  formatChord,
  isEditableTarget,
  isHelpOpen,
  isTerminalTarget,
  matchShortcut,
  onShortcut,
  setHelpOpen,
  shortcutsForHelp,
  subscribeHelp,
  type ShortcutKeyEvent,
} from './shortcuts'

function keyEvent(
  key: string,
  init: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    target: null,
    ...init,
  }
}

/** Tiny stand-in for Element.closest so node tests can exercise when-guards. */
function fakeEl(opts: {
  tag?: string
  type?: string
  xterm?: boolean
  editable?: boolean
}): { closest: (sel: string) => unknown; tagName: string; type: string } {
  const tag = (opts.tag ?? 'DIV').toUpperCase()
  const type = opts.type ?? 'text'
  const self = {
    tagName: tag,
    type,
    closest(sel: string) {
      if (opts.xterm && sel.includes('.xterm')) return self
      if (
        opts.editable &&
        (sel.includes('input') || sel.includes('textarea') || sel.includes('contenteditable'))
      ) {
        return self
      }
      if (tag === 'INPUT' && sel.includes('input')) return self
      if (tag === 'TEXTAREA' && sel.includes('textarea')) return self
      return null
    },
  }
  return self
}

afterEach(() => {
  setHelpOpen(false)
})

describe('formatChord', () => {
  it('joins modifiers for non-Mac', () => {
    expect(formatChord({ key: 'r', ctrl: true, shift: true }, false)).toBe('Ctrl+Shift+R')
    expect(formatChord({ key: 'F8' }, false)).toBe('F8')
    expect(formatChord({ key: '?' }, false)).toBe('?')
  })

  it('uses symbols on Mac', () => {
    expect(formatChord({ key: 'b', ctrl: true }, true)).toBe('⌘B')
    expect(formatChord({ key: 'F11', shift: true }, true)).toBe('⇧F11')
  })
})

describe('shortcutsForHelp packing weights', () => {
  it('keeps General as a short group (one row)', () => {
    const general = shortcutsForHelp().find((g) => g.category === 'General')!
    expect(general.items).toHaveLength(1)
  })
})

describe('shortcutsForHelp', () => {
  it('groups by category and dedupes alternate help chords', () => {
    const groups = shortcutsForHelp()
    expect(groups.map((g) => g.category)).toEqual([
      'General',
      'Run',
      'Tour',
      'Layout',
      'Session',
      'Network',
    ])
    const general = groups.find((g) => g.category === 'General')!
    expect(general.items.filter((i) => i.title === 'Shortcuts')).toHaveLength(1)
  })
})

describe('matchShortcut', () => {
  it('matches ? when idle (not typing, not terminal)', () => {
    expect(matchShortcut(keyEvent('?'))?.id).toBe('help')
  })

  it('matches Ctrl+/ as the help alternate', () => {
    expect(matchShortcut(keyEvent('/', { ctrlKey: true }))?.id).toBe('help-alt')
    expect(matchShortcut(keyEvent('/', { metaKey: true }))?.id).toBe('help-alt')
  })

  it('matches run-control F-keys', () => {
    expect(matchShortcut(keyEvent('F8'))?.id).toBe('run-toggle')
    expect(matchShortcut(keyEvent('F10'))?.id).toBe('step-over')
    expect(matchShortcut(keyEvent('F11'))?.id).toBe('step-into')
    expect(matchShortcut(keyEvent('F11', { shiftKey: true }))?.id).toBe('step-out')
  })

  it('ignores bare letters while focus is in the terminal', () => {
    const target = fakeEl({ xterm: true, tag: 'TEXTAREA' }) as unknown as EventTarget
    expect(matchShortcut(keyEvent('c', { target }))).toBeNull()
    expect(matchShortcut(keyEvent('F8', { target }))?.id).toBe('run-toggle')
  })

  it('ignores shortcuts while typing in a text input', () => {
    const target = fakeEl({ tag: 'INPUT', type: 'text', editable: true }) as unknown as EventTarget
    expect(matchShortcut(keyEvent('F8', { target }))).toBeNull()
    expect(matchShortcut(keyEvent('?', { target }))).toBeNull()
  })
})

describe('isEditableTarget / isTerminalTarget', () => {
  it('treats text inputs as editable but not checkboxes', () => {
    const text = fakeEl({ tag: 'INPUT', type: 'text', editable: true }) as unknown as EventTarget
    const box = fakeEl({ tag: 'INPUT', type: 'checkbox', editable: true }) as unknown as EventTarget
    expect(isEditableTarget(text)).toBe(true)
    expect(isEditableTarget(box)).toBe(false)
  })

  it('detects xterm ancestors', () => {
    const term = fakeEl({ xterm: true }) as unknown as EventTarget
    expect(isTerminalTarget(term)).toBe(true)
    expect(isTerminalTarget(fakeEl({}) as unknown as EventTarget)).toBe(false)
  })
})

describe('dispatchShortcut', () => {
  it('invokes the registered handler and reports handled', () => {
    const spy = vi.fn()
    const unsub = onShortcut('run-toggle', spy)
    try {
      expect(dispatchShortcut(keyEvent('F8'))).toBe(true)
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      unsub()
    }
  })

  it('returns false when the handler declines', () => {
    const unsub = onShortcut('run-toggle', () => false)
    try {
      expect(dispatchShortcut(keyEvent('F8'))).toBe(false)
    } finally {
      unsub()
    }
  })

  it('returns false when no handler is registered', () => {
    expect(dispatchShortcut(keyEvent('F8'))).toBe(false)
  })
})

describe('help open state', () => {
  it('notifies subscribers', () => {
    const spy = vi.fn()
    const unsub = subscribeHelp(spy)
    setHelpOpen(true)
    expect(isHelpOpen()).toBe(true)
    expect(spy).toHaveBeenCalled()
    setHelpOpen(false)
    unsub()
  })
})
