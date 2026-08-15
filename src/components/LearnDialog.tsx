/**
 * The Learn dialog: the envnode curriculum as four strictly ordered tracks.
 *
 * The catalog (src/learn/tracks.ts) decides what exists and what is still a
 * locked placeholder; the progress store (src/learn/progressStore.ts) owns
 * which steps the user marked done and which one is running. This component
 * is only the presentation: it never writes progress except through the
 * store, and launching a step is handed up to App, because a committed QEMU
 * session navigates and this dialog will not survive it.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Check, ChevronDown, GraduationCap, Play } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { registerCommand, runCommand } from '@/lib/commands'
import { cn } from '@/lib/utils'
import {
  TRACKS,
  isGuidedStep,
  isUnlocked,
  nextStep,
  progressLabel,
  seriesProgress,
  stepMatchesSelection,
  suggestNextTrack,
  trackProgress,
  type LearnStep,
  type LearnTrack,
} from '@/learn/tracks'
import { getSnapshot, setStepDone, subscribe } from '@/learn/progressStore'

interface Props {
  boardId: string
  sampleId: string
  onLaunchStep: (step: LearnStep) => void
}

export function LearnDialog({ boardId, sampleId, onLaunchStep }: Props) {
  const [open, setOpen] = useState(false)
  const progress = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const series = seriesProgress(progress.done)
  const suggested = useMemo(
    () => suggestNextTrack(TRACKS, progress.done),
    [progress.done],
  )
  // The suggested track opens expanded; with nothing to suggest (all locked,
  // or everything done) the first track carries the shape of the series.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  useEffect(() => {
    if (open) setExpandedId((suggested ?? TRACKS[0]).id)
    // Recompute only when the dialog opens; toggles while open are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => registerCommand('open-learn', () => setOpen(true)), [])

  const launch = (step: LearnStep) => {
    setOpen(false)
    onLaunchStep(step)
  }

  const inProgress = series.done > 0 && series.done < series.total

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="shrink-0"
          aria-label="Open the Learn tracks"
          title="A guided series of tutorials, in order. Progress stays in this browser"
        >
          <GraduationCap aria-hidden />
          <span className="hidden sm:inline">Learn</span>
          {inProgress && (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {series.done}/{series.total}
            </span>
          )}
        </Button>
      </DialogTrigger>

      <DialogContent className="h-[min(85vh,44rem)] max-w-xl">
        <DialogHeader>
          <DialogTitle>Learn Zephyr</DialogTitle>
          <DialogDescription className="space-y-1.5">
            <span className="block">
              You know embedded; Zephyr is the new part. These tracks build one
              thing, an environmental node called envnode, from a bare main()
              to a tested, observable product. Strictly in order; each step
              leans on the one before.
            </span>
            <span className="block">
              The series lands one tutorial at a time; a row wakes up when its
              app does.
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-1">
          {TRACKS.map((track) => (
            <TrackSection
              key={track.id}
              track={track}
              done={progress.done}
              activeStepId={progress.activeStepId}
              boardId={boardId}
              sampleId={sampleId}
              expanded={expandedId === track.id}
              suggested={suggested?.id === track.id}
              onToggle={() =>
                setExpandedId((id) => (id === track.id ? null : track.id))
              }
              onLaunch={launch}
            />
          ))}
        </div>

        <DialogFooter className="justify-between">
          <span className="text-[11px] text-muted-foreground">
            Progress lives in this browser. Clear site data and it goes with it.
          </span>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false)
              runCommand('open-samples')
            }}
          >
            Browse all samples
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TrackSection({
  track,
  done,
  activeStepId,
  boardId,
  sampleId,
  expanded,
  suggested,
  onToggle,
  onLaunch,
}: {
  track: LearnTrack
  done: ReadonlySet<string>
  activeStepId: string | null
  boardId: string
  sampleId: string
  expanded: boolean
  suggested: boolean
  onToggle: () => void
  onLaunch: (step: LearnStep) => void
}) {
  const p = trackProgress(track, done)
  const finished = p.total > 0 && p.done >= p.total
  const upNext = nextStep(track, done)

  return (
    <section className="py-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left',
          'transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring',
        )}
      >
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90')}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{track.title}</span>
        {suggested && !finished && (
          <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            up next
          </span>
        )}
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {progressLabel(p)}
        </span>
      </button>

      {expanded && (
        <div className="space-y-0.5 pb-1 pl-4 pr-1">
          <p className="px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground">
            {track.intro}
          </p>
          {track.steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              done={done.has(step.id)}
              isNext={upNext?.id === step.id}
              running={
                activeStepId === step.id && stepMatchesSelection(step, boardId, sampleId)
              }
              onLaunch={onLaunch}
            />
          ))}
          {finished && (
            <p className="px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground">
              {track.finished}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function StepRow({
  step,
  done,
  isNext,
  running,
  onLaunch,
}: {
  step: LearnStep
  done: boolean
  isNext: boolean
  running: boolean
  onLaunch: (step: LearnStep) => void
}) {
  const unlocked = isUnlocked(step)
  const guided = isGuidedStep(step)

  if (!unlocked) {
    return (
      <div className="flex items-start gap-2.5 rounded-md px-2.5 py-1.5 opacity-60">
        <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {step.num}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm leading-5 text-muted-foreground">
              {step.title}
            </span>
            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
              still being written
            </span>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground/80">
            {step.takeaway}
          </p>
        </div>
      </div>
    )
  }

  return (
    // Like the gallery's rows: a launch control with a real button inside it,
    // so a div with role=button rather than nested <button>s.
    <div
      role="button"
      tabIndex={0}
      aria-label={`Start this step: ${step.num} ${step.title}`}
      onClick={() => onLaunch(step)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onLaunch(step)
        }
      }}
      className={cn(
        'group flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left',
        'transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring',
        (isNext || running) && 'bg-primary/10 ring-1 ring-primary',
      )}
    >
      <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {step.num}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium leading-5">{step.title}</span>
          {guided && (
            <span
              className="flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              title="Carries a guided tour: it stops and explains itself as it runs"
            >
              <GraduationCap className="size-2.5" aria-hidden />
              guided
            </span>
          )}
          {running ? (
            <span className="flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              <Play className="size-2.5" aria-hidden />
              running now
            </span>
          ) : (
            isNext && (
              <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                up next
              </span>
            )
          )}
        </div>
        <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
          {step.takeaway}
        </p>
        {!guided && step.tryThis && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">
            Try it: {step.tryThis}
          </p>
        )}
      </div>
      <DoneToggle stepId={step.id} done={done} />
    </div>
  )
}

/** The manual completion control: Mark as done, click again to unmark. */
export function DoneToggle({ stepId, done }: { stepId: string; done: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={done}
      title="Kept in this browser. Nothing leaves the page."
      onClick={(e) => {
        e.stopPropagation()
        setStepDone(stepId, !done)
      }}
      className={cn(
        'shrink-0 self-center rounded-md border px-2 py-1 text-[11px] transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        done
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {done ? (
        <span className="flex items-center gap-1">
          <Check className="size-3" aria-hidden />
          Done
        </span>
      ) : (
        'Mark as done'
      )}
    </button>
  )
}
