/**
 * Replay a Trace recording: the live panel's tabs, driven by a transport.
 *
 * Opens when a recording stops (the guest pauses with it), or from the Replay
 * button in the Trace tab strip. Playing feeds the recorded CTF through the
 * decoder at the chosen speed (tracePlayback.ts), so Timeline and IPC move as
 * they did live, only slower, and the scrubber goes back to any moment.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { Pause, Play, SkipBack, StepBack, StepForward } from 'lucide-react'
import { TracePanelBody } from '@/components/TracePanel'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ownThreadPriorities } from '@/debug/kernel/objectCores'
import { fmtTime } from '@/ctf'
import * as debug from '@/debug/control'
import * as hostGdb from '@/hostGdb'
import { STAGE_TRACE_KEY, getState as getDockState, tabIn } from '@/lib/dockStore'
import { TRACE_TABS, type TraceTab } from '@/lib/traceTabs'
import { cn } from '@/lib/utils'
import { REPLAY_SPEEDS, TraceReplay } from '@/tracePlayback'
import * as recorder from '@/traceRecorder'
import type { TraceRecording } from '@/traceRecorder'

/** One replay per recording, so closing and reopening keeps the position. */
const replays = new WeakMap<TraceRecording, TraceReplay>()

function replayFor(recording: TraceRecording): TraceReplay {
  let replay = replays.get(recording)
  if (!replay) {
    replay = new TraceReplay(recording)
    replays.set(recording, replay)
  }
  return replay
}

function speedLabel(speed: number): string {
  return speed === 1 ? '1× real time' : `${speed}×`
}

const ICON_BUTTON =
  'rounded p-1 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground disabled:opacity-40'

export function TraceReplayDialog() {
  const rec = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot)
  const recording = rec.replayOpen ? rec.last : null
  return (
    <Dialog open={recording !== null} onOpenChange={(open) => !open && recorder.closeReplay()}>
      {recording && <ReplayContent recording={recording} />}
    </Dialog>
  )
}

function ReplayContent({ recording }: { recording: TraceRecording }) {
  const replay = useMemo(() => replayFor(recording), [recording])
  const snap = useSyncExternalStore(replay.subscribe, replay.getSnapshot, replay.getSnapshot)
  const run = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const gdbSnap = useSyncExternalStore(hostGdb.subscribe, hostGdb.getSnapshot, hostGdb.getSnapshot)
  const priorities = useMemo(
    () => ownThreadPriorities(gdbSnap.threads, gdbSnap.objects),
    [gdbSnap.threads, gdbSnap.objects],
  )
  // Opens on the tab the live panel was showing, then goes its own way.
  const [tab, setTab] = useState<TraceTab>(
    () => tabIn(getDockState(), STAGE_TRACE_KEY, TRACE_TABS, 'schedule') as TraceTab,
  )
  const [followNonce, setFollowNonce] = useState(0)
  // A dragged scrubber fires faster than a seek back can decode: keep the latest.
  const pendingSeek = useRef<number | null>(null)
  const seekFrame = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      replay.pause()
      if (seekFrame.current !== undefined) cancelAnimationFrame(seekFrame.current)
    },
    [replay],
  )

  const refollow = () => setFollowNonce((n) => n + 1)
  const seek = (ts: number) => {
    pendingSeek.current = ts
    if (seekFrame.current !== undefined) return
    seekFrame.current = requestAnimationFrame(() => {
      seekFrame.current = undefined
      const target = pendingSeek.current
      pendingSeek.current = null
      if (target !== null) replay.seek(target)
    })
    refollow()
  }
  const toggle = () => {
    // Restarting from the end jumps back to the start: show it from there.
    if (!snap.playing) refollow()
    replay.toggle()
  }
  const step = (direction: 1 | -1) => {
    replay.pause()
    replay.step(direction)
    refollow()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const target = e.target as HTMLElement
    // A field types its keys, the IPC filter included.
    if (target.closest('input:not([type="range"]), textarea, [contenteditable="true"]')) return
    // Space on a button presses it.
    const ownsSpace = target.closest('button, select, [role="combobox"]')
    if (e.key === ' ' && !ownsSpace) {
      e.preventDefault()
      toggle()
    } else if (e.key === ',') {
      e.preventDefault()
      step(-1)
    } else if (e.key === '.') {
      e.preventDefault()
      step(1)
    }
  }

  const duration = snap.endTs - snap.startTs
  const elapsed = snap.cursor - snap.startTs
  const note =
    recording.reason === 'limit'
      ? ` · stopped at the ${recorder.MAX_RECORDED_EVENTS.toLocaleString('en-US')}-event limit`
      : recording.reason === 'ended'
        ? ' · the trace stream ended while recording'
        : ''
  const guestPaused = run.available && run.paused

  return (
    <DialogContent
      className="max-h-[92vh] w-[96vw] max-w-6xl gap-0 overflow-hidden p-0"
      // Nothing behind the replay follows its cursor: the device panels, the
      // terminal and the live Trace show the machine as it is now. Drained of
      // colour, a lit LED there cannot pass for one in the replayed moment.
      overlayClassName="backdrop-grayscale"
      onKeyDown={onKeyDown}
    >
      <DialogHeader className="border-b border-border pr-12">
        <DialogTitle>Trace replay</DialogTitle>
        <DialogDescription>
          {fmtTime(duration)} of guest time · {snap.total.toLocaleString('en-US')} events
          {note}
        </DialogDescription>
      </DialogHeader>

      <div
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2"
        role="group"
        aria-label="Replay transport"
      >
        <button
          type="button"
          className={ICON_BUTTON}
          title="Back to the start"
          aria-label="Back to the start"
          onClick={() => {
            replay.pause()
            seek(snap.startTs)
          }}
        >
          <SkipBack className="size-4" />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          title="Previous event (,)"
          aria-label="Previous event"
          disabled={snap.cursor <= snap.startTs}
          onClick={() => step(-1)}
        >
          <StepBack className="size-4" />
        </button>
        <button
          type="button"
          className={cn(ICON_BUTTON, 'text-foreground')}
          title={snap.playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={snap.playing ? 'Pause' : 'Play'}
          onClick={toggle}
        >
          {snap.playing ? <Pause className="size-5" /> : <Play className="size-5 text-primary" />}
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          title="Next event (.)"
          aria-label="Next event"
          disabled={snap.cursor >= snap.endTs}
          onClick={() => step(1)}
        >
          <StepForward className="size-4" />
        </button>

        <Select value={String(snap.speed)} onValueChange={(v) => replay.setSpeed(Number(v))}>
          <SelectTrigger
            className="h-7 w-[7.5rem] px-2 text-[11px]"
            aria-label="Playback speed"
            title="Guest time per wall-clock second"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REPLAY_SPEEDS.map((speed) => (
              <SelectItem key={speed} value={String(speed)} className="text-[11px]">
                {speedLabel(speed)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <input
          type="range"
          className="min-w-40 flex-1 accent-primary"
          aria-label="Replay position"
          title="Drag to go back and forth in the recording"
          min={0}
          max={Math.max(1, duration)}
          step={Math.max(1, duration / 10_000)}
          value={elapsed}
          onChange={(e) => seek(snap.startTs + Number(e.currentTarget.value))}
        />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          <span className="text-foreground">{fmtTime(elapsed)}</span> / {fmtTime(duration)}
          {/* The charts' time axes count from boot, not from the recording. */}
          <span className="ml-2 hidden sm:inline" title="Guest time since boot, as on the time axis">
            at {fmtTime(snap.cursor)} · event {snap.position.toLocaleString('en-US')} of{' '}
            {snap.total.toLocaleString('en-US')}
          </span>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TracePanelBody
          snap={snap.trace}
          objectCores={gdbSnap.objects}
          priorities={priorities}
          replay={{
            requestDetailUpdates: replay.requestDetailUpdates,
            tab,
            setTab,
            followNonce,
          }}
        />
      </div>

      <DialogFooter className="justify-between">
        <span className="text-[11px] text-muted-foreground">
          {guestPaused
            ? 'The grayed-out panels behind are paused where recording stopped; they don’t follow the replay.'
            : 'The grayed-out panels behind are still running; they don’t follow the replay.'}
        </span>
        <span className="flex items-center gap-2">
          {guestPaused && (
            <Button variant="ghost" size="sm" onClick={debug.resume}>
              Resume guest
            </Button>
          )}
          <Button size="sm" onClick={recorder.closeReplay}>
            Close
          </Button>
        </span>
      </DialogFooter>
    </DialogContent>
  )
}
