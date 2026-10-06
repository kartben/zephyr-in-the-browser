/**
 * The card a tour with an intro opens on: the text before its first step, its
 * diagram, and the stops ahead, on a card of their own.
 *
 * They used to sit on top of step 1, so the line the guest had stopped on was
 * a scroll away under the map of the whole sample. Here the map comes first,
 * while the guest boots, and step 1 comes up on its own when the reader starts.
 * Start waits for the first stop: before it, there is nothing to start to.
 *
 * Opened again from a card's header, the same card offers Back instead.
 */

import { ArrowRight, GraduationCap, LoaderCircle } from 'lucide-react'
import { InlineMarkdown, Markdown, PROSE } from '@/components/Markdown'
import { CopyTourLink } from '@/components/tour/TourLink'
import { TourFrame } from '@/components/tour/TourFrame'
import { Button } from '@/components/ui/button'
import { closeIntro, introReady, openIntro, skip, type TourState } from '@/tours/store'
import { cn } from '@/lib/utils'

interface Props {
  boardId: string
  sampleId: string
  state: TourState
}

export function IntroCard({ boardId, sampleId, state }: Props) {
  const doc = state.doc!
  const again = state.intro === 'again'
  const ready = again || introReady(state)
  const steps = doc.steps
  const from = state.startIndex
  const paused = state.current?.paused === true && !state.current.revisit

  return (
    <TourFrame
      data-tour-intro=""
      header={
        <>
          <GraduationCap className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span
            className="min-w-0 truncate text-[12px] font-medium text-foreground/80"
            title={doc.title}
          >
            <InlineMarkdown text={doc.title} />
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {steps.length} {steps.length === 1 ? 'stop' : 'stops'}
          </span>
          {state.tourId && (
            <div className="ml-auto flex items-center">
              <CopyTourLink boardId={boardId} sampleId={sampleId} tourId={state.tourId} step={from + 1} />
            </div>
          )}
        </>
      }
      footer={
        <>
          {again ? (
            <Button size="sm" onClick={closeIntro} className="h-7 px-3 text-xs">
              Back
            </Button>
          ) : (
            <Button
              size="sm"
              data-tour-start=""
              disabled={!ready}
              onClick={closeIntro}
              className="h-7 px-3 text-xs"
            >
              {ready ? (
                <>
                  {from > 0 ? `Start at stop ${from + 1}` : 'Start'}
                  <ArrowRight className="size-3" aria-hidden />
                </>
              ) : (
                <>
                  <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
                  Waiting for the first stop
                </>
              )}
            </Button>
          )}
          {!again && ready && paused && (
            <span className="text-[11px] text-muted-foreground">The guest is paused at the first stop</span>
          )}
          <button
            type="button"
            onClick={skip}
            title="Drop the tour's breakpoints and let the sample run"
            className="ml-auto text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Leave the tour
          </button>
        </>
      }
      bodyClassName="space-y-3 px-3 py-2.5"
    >
      <Markdown body={doc.intro} className={PROSE} />

      {steps.length > 0 && (
        <div className="rounded border border-border bg-muted/30 px-3 py-2">
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            In this tour, {steps.length} {steps.length === 1 ? 'stop' : 'stops'}
            {from > 0 && `, from stop ${from + 1}`}
          </p>
          <ol className="space-y-1">
            {steps.map((step) => (
              <li
                key={step.index}
                className={cn(
                  'flex items-baseline gap-2.5 text-[14px] leading-[20px]',
                  // A `?step=` link skips the stops before its own.
                  step.index < from ? 'text-muted-foreground' : 'text-prose',
                )}
              >
                <span className="w-3 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {step.index + 1}
                </span>
                <InlineMarkdown text={step.title} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </TourFrame>
  )
}

/**
 * The tour's title in a card's header, so every card says which tour (and
 * which part of a series) it belongs to. With an intro, it opens it again.
 */
export function TourTitle({ title, hasIntro }: { title: string; hasIntro: boolean }) {
  const className = 'min-w-0 truncate text-[12px] font-medium text-foreground/80'
  if (!hasIntro) {
    return (
      <span className={className} title={title}>
        <InlineMarkdown text={title} />
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={openIntro}
      title={`${title}: read the intro again`}
      className={cn(className, 'text-left hover:text-foreground')}
    >
      <InlineMarkdown text={title} />
    </button>
  )
}
