/**
 * Global keyboard shortcut registry.
 *
 * One table drives both the `?` help dialog and the keydown matcher, so the
 * chord shown in the UI is the chord that actually fires. Handlers attach by
 * id (see `src/shortcuts/bindings.ts`) to keep this module free of host/UI
 * imports.
 */

import type en from '@/locales/en.json'

export type ShortcutCategory =
  | 'General'
  | 'Run'
  | 'Tour'
  | 'Layout'
  | 'Session'
  | 'Network'

export interface KeyChord {
  /** `KeyboardEvent.key`, compared case-insensitively for single letters. */
  key: string
  shift?: boolean
  /** True matches Ctrl on Windows/Linux and Meta (⌘) on macOS. */
  ctrl?: boolean
  alt?: boolean
}

/**
 * Where a shortcut's words are: `shortcuts.items.<label>` in
 * src/locales/en.json, a concise `title` (about 2–4 words) and a help blurb
 * `description` (about 3–5 words). Typed from that file, so a shortcut with
 * no strings fails typecheck.
 */
export type ShortcutLabel = keyof (typeof en)['shortcuts']['items']

export interface Shortcut {
  id: string
  category: ShortcutCategory
  /** Its title and description in the locale files; two chords for one action share one. */
  label: ShortcutLabel
  chord: KeyChord
  /**
   * When to honor the chord:
   * - `global` — even while typing in inputs
   * - `app` — skip editable fields; still fire over the terminal (F-keys / mod)
   * - `idle` — skip editable fields and the xterm surface (bare letters)
   */
  when?: 'global' | 'app' | 'idle'
}

/** Category display order in the help dialog. */
export const SHORTCUT_CATEGORY_ORDER: readonly ShortcutCategory[] = [
  'General',
  'Run',
  'Tour',
  'Layout',
  'Session',
  'Network',
] as const

/**
 * The starter set. Add new chords here; wire `onShortcut(id, …)` in bindings,
 * and give the label its words in src/locales/en.json. Keep them short: the
 * help dialog is a glance, not a manual.
 */
export const SHORTCUTS: readonly Shortcut[] = [
  // General
  {
    id: 'help',
    category: 'General',
    label: 'help',
    chord: { key: '?' },
    when: 'idle',
  },
  {
    id: 'help-alt',
    category: 'General',
    label: 'help',
    chord: { key: '/', ctrl: true },
    when: 'app',
  },

  // Run
  {
    id: 'run-toggle',
    category: 'Run',
    label: 'run-toggle',
    chord: { key: 'F8' },
    when: 'app',
  },
  {
    id: 'step-over',
    category: 'Run',
    label: 'step-over',
    chord: { key: 'F10' },
    when: 'app',
  },
  {
    id: 'step-into',
    category: 'Run',
    label: 'step-into',
    chord: { key: 'F11' },
    when: 'app',
  },
  {
    id: 'step-out',
    category: 'Run',
    label: 'step-out',
    chord: { key: 'F11', shift: true },
    when: 'app',
  },
  {
    id: 'restart',
    category: 'Run',
    label: 'restart',
    chord: { key: 'r', ctrl: true, shift: true },
    when: 'app',
  },

  // Tour
  {
    id: 'tour-continue',
    category: 'Tour',
    label: 'tour-continue',
    chord: { key: 'c' },
    when: 'idle',
  },
  {
    id: 'tour-step',
    category: 'Tour',
    label: 'tour-step',
    chord: { key: 's' },
    when: 'idle',
  },
  {
    id: 'tour-leave',
    category: 'Tour',
    label: 'tour-leave',
    chord: { key: 'x' },
    when: 'idle',
  },
  {
    id: 'tour-minimise',
    category: 'Tour',
    label: 'tour-minimise',
    chord: { key: 'Escape' },
    when: 'idle',
  },

  // Layout
  {
    id: 'toggle-dock',
    category: 'Layout',
    label: 'toggle-dock',
    chord: { key: 'b', ctrl: true },
    when: 'app',
  },
  {
    id: 'toggle-debug',
    category: 'Layout',
    label: 'toggle-debug',
    chord: { key: 'd', ctrl: true, shift: true },
    when: 'app',
  },
  {
    id: 'toggle-trace',
    category: 'Layout',
    label: 'toggle-trace',
    chord: { key: 't', ctrl: true, shift: true },
    when: 'app',
  },
  {
    id: 'reset-layout',
    category: 'Layout',
    label: 'reset-layout',
    chord: { key: 'l', ctrl: true, shift: true },
    when: 'app',
  },

  // Session
  {
    id: 'open-samples',
    category: 'Session',
    label: 'open-samples',
    chord: { key: 'k', ctrl: true },
    when: 'app',
  },
  {
    id: 'open-settings',
    category: 'Session',
    label: 'open-settings',
    chord: { key: ',', ctrl: true },
    when: 'app',
  },

  // Network
  {
    id: 'net-capture-toggle',
    category: 'Network',
    label: 'net-capture-toggle',
    chord: { key: 'n', ctrl: true, shift: true },
    when: 'app',
  },
  {
    id: 'net-export-pcap',
    category: 'Network',
    label: 'net-export-pcap',
    chord: { key: 'e', ctrl: true, shift: true },
    when: 'app',
  },
] as const

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]))
/** Return `false` to leave the event unhandled (no preventDefault). */
export type ShortcutHandler = () => boolean | void
const handlers = new Map<string, ShortcutHandler>()

let helpOpen = false
const helpListeners = new Set<() => void>()

function notifyHelp() {
  for (const fn of helpListeners) fn()
}

export function subscribeHelp(fn: () => void): () => void {
  helpListeners.add(fn)
  return () => {
    helpListeners.delete(fn)
  }
}

export function isHelpOpen(): boolean {
  return helpOpen
}

export function setHelpOpen(open: boolean): void {
  if (helpOpen === open) return
  helpOpen = open
  notifyHelp()
}

export function toggleHelp(): void {
  setHelpOpen(!helpOpen)
}

/** Attach or replace the action for a shortcut id. */
export function onShortcut(id: string, fn: ShortcutHandler): () => void {
  if (!byId.has(id)) {
    throw new Error(`unknown shortcut id: ${id}`)
  }
  handlers.set(id, fn)
  return () => {
    if (handlers.get(id) === fn) handlers.delete(id)
  }
}

export function getShortcut(id: string): Shortcut | undefined {
  return byId.get(id)
}

/** Grouped list for the help dialog; lists a label once per category, whatever its chords. */
export function shortcutsForHelp(): { category: ShortcutCategory; items: Shortcut[] }[] {
  const seen = new Set<string>()
  const groups = new Map<ShortcutCategory, Shortcut[]>()
  for (const category of SHORTCUT_CATEGORY_ORDER) groups.set(category, [])

  for (const shortcut of SHORTCUTS) {
    const dedupe = `${shortcut.category}:${shortcut.label}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    groups.get(shortcut.category)!.push(shortcut)
  }

  return SHORTCUT_CATEGORY_ORDER.filter((c) => (groups.get(c)?.length ?? 0) > 0).map(
    (category) => ({ category, items: groups.get(category)! }),
  )
}

export function formatChord(chord: KeyChord, mac = isMacPlatform()): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push(mac ? '⌘' : 'Ctrl')
  if (chord.alt) parts.push(mac ? '⌥' : 'Alt')
  if (chord.shift) parts.push(mac ? '⇧' : 'Shift')
  parts.push(displayKey(chord.key))
  return parts.join(mac ? '' : '+')
}

function displayKey(key: string): string {
  if (key === ' ') return 'Space'
  if (key === 'Escape') return 'Esc'
  if (key.length === 1) return key.toUpperCase()
  return key
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

/** Minimal keydown shape — real KeyboardEvents satisfy this. */
export interface ShortcutKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  isComposing: boolean
  defaultPrevented: boolean
  target: EventTarget | null
}

/** True when the event target is an editable field (or contentEditable). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const el = (target as Element).closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  )
  if (!el) return false
  if (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) {
    const type = el.type
    // Checkbox / radio / button / range should not swallow app shortcuts.
    if (
      type === 'button' ||
      type === 'checkbox' ||
      type === 'radio' ||
      type === 'range' ||
      type === 'file' ||
      type === 'reset' ||
      type === 'submit'
    ) {
      return false
    }
  } else if ((el as HTMLInputElement).tagName === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
    if (
      type === 'button' ||
      type === 'checkbox' ||
      type === 'radio' ||
      type === 'range' ||
      type === 'file' ||
      type === 'reset' ||
      type === 'submit'
    ) {
      return false
    }
  }
  return true
}

/** True when focus is inside an xterm terminal surface. */
export function isTerminalTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  return (target as Element).closest('.xterm') !== null
}

function chordMatches(chord: KeyChord, event: ShortcutKeyEvent): boolean {
  const wantCtrl = chord.ctrl === true
  const wantShift = chord.shift === true
  const wantAlt = chord.alt === true
  const hasCtrl = event.ctrlKey || event.metaKey
  if (hasCtrl !== wantCtrl) return false
  if (event.altKey !== wantAlt) return false
  // Shift is significant for letter chords and F-keys; ignore for `?` which
  // is already the shifted form of `/` on common layouts.
  if (chord.key !== '?' && event.shiftKey !== wantShift) return false
  return event.key.toLowerCase() === chord.key.toLowerCase()
}

function whenAllows(shortcut: Shortcut, event: ShortcutKeyEvent): boolean {
  const mode = shortcut.when ?? 'app'
  if (mode === 'global') return true
  // xterm hosts a hidden textarea — that is guest typing, not a UI form field.
  // `app` chords (F-keys / modifiers) still fire; bare `idle` letters do not.
  if (isTerminalTarget(event.target)) return mode === 'app'
  if (isEditableTarget(event.target)) return false
  return true
}

/** First matching shortcut definition, or null. */
export function matchShortcut(event: ShortcutKeyEvent): Shortcut | null {
  if (event.defaultPrevented || event.isComposing) return null
  // Repeat keys: allow run-control F-keys to re-fire; skip the rest.
  for (const shortcut of SHORTCUTS) {
    if (!chordMatches(shortcut.chord, event)) continue
    if (!whenAllows(shortcut, event)) continue
    if (event.repeat && shortcut.category !== 'Run') continue
    return shortcut
  }
  return null
}

/**
 * Match and invoke a shortcut. Returns true when handled (caller should
 * preventDefault / stopPropagation). Handlers may return `false` to decline.
 */
export function dispatchShortcut(event: ShortcutKeyEvent): boolean {
  const shortcut = matchShortcut(event)
  if (!shortcut) return false
  const handler = handlers.get(shortcut.id)
  if (!handler) return false
  return handler() !== false
}
