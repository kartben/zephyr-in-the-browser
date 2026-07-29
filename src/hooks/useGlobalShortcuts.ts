/**
 * Document-level keydown → shortcut dispatch. Mount once near the app root.
 */

import { useEffect } from 'react'
import { dispatchShortcut } from '@/lib/shortcuts'
import { installShortcutBindings } from '@/shortcuts/bindings'

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const uninstall = installShortcutBindings()
    const onKeyDown = (event: KeyboardEvent) => {
      if (!dispatchShortcut(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    // Capture so we see the event before xterm / focused controls swallow it
    // for modifier and function-key chords (`when: 'app'`).
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      uninstall()
    }
  }, [])
}
