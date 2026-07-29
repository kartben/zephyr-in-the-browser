/**
 * Wire shortcut ids to real actions. Imported once from the app shell so the
 * registry in `shortcuts.ts` stays free of host/UI imports.
 *
 * Handlers return `false` when the action does not apply (no tour, no net, …)
 * so the key is left for the focused control.
 */

import { runCommand } from '@/lib/commands'
import {
  STAGE_DEBUG_KEY,
  STAGE_TRACE_KEY,
  effectiveExpanded,
  getState as getDockState,
  isHidden,
  resetLayout,
  setExpanded,
  setHidden,
  setOpen as setDockOpen,
} from '@/lib/dockStore'
import { revealStagePanel } from '@/lib/dockReveal'
import { onShortcut, toggleHelp } from '@/lib/shortcuts'
import * as debug from '@/debug/control'
import * as hostNet from '@/hostNet'
import * as tours from '@/tours/store'

function toggleStagePanel(key: string): void {
  const hidden = isHidden(key)
  const expanded = effectiveExpanded(key)
  if (hidden || !expanded) {
    setHidden(key, false)
    setExpanded(key, true)
    revealStagePanel(key)
    return
  }
  setExpanded(key, false)
}

function downloadPcap(): void {
  const blob = hostNet.buildPcapBlob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `zephyr-net-${new Date().toISOString().replace(/[:.]/g, '-')}.pcap`
  a.click()
  URL.revokeObjectURL(url)
}

function tourActive(): boolean {
  const state = tours.getSnapshot()
  return state.enabled && state.current !== null
}

/** Install every starter-set handler. Call once from the app shell. */
export function installShortcutBindings(): () => void {
  const unsubs = [
    onShortcut('help', () => {
      toggleHelp()
    }),
    onShortcut('help-alt', () => {
      toggleHelp()
    }),

    onShortcut('run-toggle', () => {
      if (!debug.getSnapshot().available) return false
      debug.toggle()
    }),
    onShortcut('step-over', () => {
      if (!debug.getSnapshot().canStep) return false
      void debug.stepOver()
    }),
    onShortcut('step-into', () => {
      if (!debug.getSnapshot().canStep) return false
      void debug.step()
    }),
    onShortcut('step-out', () => {
      if (!debug.getSnapshot().canStep) return false
      void debug.stepOut()
    }),
    onShortcut('restart', () => {
      runCommand('restart')
    }),

    onShortcut('tour-continue', () => {
      if (!tourActive()) return false
      tours.next()
    }),
    onShortcut('tour-step', () => {
      if (!tourActive()) return false
      const state = tours.getSnapshot()
      if (!state.current?.paused || !state.live) return false
      void debug.step()
    }),
    onShortcut('tour-leave', () => {
      if (!tourActive()) return false
      tours.skip()
    }),

    onShortcut('toggle-dock', () => {
      setDockOpen(!getDockState().open)
    }),
    onShortcut('toggle-debug', () => toggleStagePanel(STAGE_DEBUG_KEY)),
    onShortcut('toggle-trace', () => toggleStagePanel(STAGE_TRACE_KEY)),
    onShortcut('reset-layout', () => {
      resetLayout()
      setDockOpen(true)
    }),

    onShortcut('open-samples', () => {
      runCommand('open-samples')
    }),

    onShortcut('net-capture-toggle', () => {
      const snap = hostNet.getSnapshot()
      if (!snap.available) return false
      hostNet.pauseCapture(!snap.capturePaused)
    }),
    onShortcut('net-export-pcap', () => {
      const snap = hostNet.getSnapshot()
      if (!snap.available || snap.captureCount === 0) return false
      downloadPcap()
    }),
  ]

  return () => {
    for (const unsub of unsubs) unsub()
  }
}
