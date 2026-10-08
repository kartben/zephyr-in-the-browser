/**
 * Record and Replay, at the right end of the live Trace tab strip.
 *
 * Recording keeps the raw CTF while the guest runs; Stop pauses the guest and
 * opens the replay (TraceReplayDialog). See traceRecorder.ts for why that is
 * cheaper than keeping more of the live trace.
 */

import { useSyncExternalStore } from 'react'
import { Circle, History, Square } from 'lucide-react'
import { fmtTime } from '@/ctf'
import * as recorder from '@/traceRecorder'

const BUTTON =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide text-foreground/55 touch-manipulation hover:bg-muted/60 hover:text-foreground'

export function TraceRecordControls() {
  const rec = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot)

  if (rec.recording) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        {/* Guest time only: the row's badge already counts the events. */}
        <span
          className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[10px] tabular-nums text-muted-foreground"
          title={`Recording: ${rec.events.toLocaleString('en-US')} events so far. Stops by itself at ${recorder.MAX_RECORDED_EVENTS.toLocaleString('en-US')}.`}
        >
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
          {fmtTime(rec.spanNs)}
        </span>
        <button
          type="button"
          className={BUTTON}
          title="Stop recording, pause the guest and replay it"
          aria-label="Stop recording"
          onClick={recorder.stop}
        >
          <Square className="size-2.5 fill-current" />
          Stop
        </button>
      </span>
    )
  }

  const canReplay = rec.last !== null && rec.last.events > 0
  return (
    <span className="flex items-center gap-0.5">
      {canReplay && (
        <button
          type="button"
          className={BUTTON}
          title="Replay the last recording"
          onClick={recorder.openReplay}
        >
          <History className="size-3" />
          Replay
        </button>
      )}
      <button
        type="button"
        className={BUTTON}
        title="Record the trace, then replay it slowed down with the guest paused"
        aria-label="Record the trace"
        onClick={() => recorder.start()}
      >
        <Circle className="size-2.5 fill-destructive text-destructive" />
        Rec
      </button>
    </span>
  )
}
