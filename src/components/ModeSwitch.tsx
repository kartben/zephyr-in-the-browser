/**
 * The session's identity: Simulator or Live board. The choice is fixed per
 * document — App persists it and navigates with an explicit ?mode=, so the
 * switch stays a live control and a later refresh cannot surprise-flip.
 */

import { Box, Cable } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { SessionMode } from '@/lib/modeStore'

export function ModeSwitch({
  mode,
  onModeChange,
}: {
  mode: SessionMode
  onModeChange: (mode: SessionMode) => void
}) {
  return (
    <span
      className="flex shrink-0 overflow-hidden rounded-md border border-border"
      role="group"
      aria-label="Session mode"
    >
      <ModeButton
        active={mode === 'sim'}
        onClick={() => onModeChange('sim')}
        label="Simulator"
        title="Run Zephyr apps in the in-page emulator"
      >
        <Box className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">Simulator</span>
      </ModeButton>
      <ModeButton
        active={mode === 'live'}
        onClick={() => onModeChange('live')}
        label="Live board"
        title="Stream and debug a real board through the desktop bridge"
      >
        <Cable className="size-3.5" aria-hidden />
        <span className="hidden sm:inline">Live board</span>
      </ModeButton>
    </span>
  )
}

function ModeButton({
  active,
  onClick,
  label,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  title: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={title}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 text-xs',
        active
          ? 'bg-primary/15 font-semibold text-primary'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
