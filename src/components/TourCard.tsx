/**
 * The card a tour step puts on screen while the machine is stopped on it.
 *
 * The prose is the same idea the old annotation popup had. What is new is
 * everything under it: a step can pull values out of the guest, put a window of
 * its memory on screen with the interesting bytes lit, spotlight the registers
 * it is about, or show the kernel's thread list — because there is a debugger
 * underneath now, and a lesson that can read the machine it is describing is a
 * different kind of lesson.
 *
 * Sits over the stage, above the device panels and below the modals.
 */

import { Fragment, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { Bug, ChevronDown, ChevronUp, GraduationCap, Pause, Redo2 } from 'lucide-react'
import { InlineMarkdown, Markdown, PROSE } from '@/components/Markdown'
import { SourceSnippet } from '@/components/SourceSnippet'
import { ThreadsPane } from '@/components/debug/ThreadsPane'
import { CheckResults } from '@/components/tour/CheckResults'
import { CompletionCard, useTourTitle } from '@/components/tour/CompletionCard'
import { IntroCard, TourTitle } from '@/components/tour/IntroCard'
import { TourHexdump } from '@/components/tour/TourHexdump'
import { TourObjects } from '@/components/tour/TourObjects'
import { TourOutline } from '@/components/tour/TourOutline'
import { CopyTourLink, StartedAt, startedAt } from '@/components/tour/TourLink'
import { TourFrame } from '@/components/tour/TourFrame'
import { WaitingCard } from '@/components/tour/WaitingCard'
import { Button } from '@/components/ui/button'
import { sampleSourceAsset, type Board } from '@/boards'
import * as debug from '@/debug/control'
import * as dtsStore from '@/devicetree'
import { stripDtsProvenance } from '@/dts/provenance'
import * as debugUi from '@/lib/debugUi'
import { pointAt } from '@/tours/look'
import {
  cardOnScreen,
  getSnapshot,
  minimise,
  next,
  restore,
  skip,
  subscribe,
  type TourValue,
} from '@/tours/store'
import { CARD_VIEWS, placedViews, resolveHighlightSpecs, type CardView } from '@/tours/parse'
import { cn } from '@/lib/utils'

interface Props {
  board: Board
  sampleId: string
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function Values({ values, live }: { values: TourValue[]; live: boolean }) {
  return (
    <dl className="divide-y divide-border/60 overflow-hidden rounded border border-border bg-muted/30">
      {values.map((value) => (
        <div key={`${value.label}:${value.expr}`} className="flex items-baseline gap-2 px-2 py-1.5">
          <dt className="min-w-0 shrink-0 basis-1/3 truncate text-[12px] text-muted-foreground">
            {value.label}
          </dt>
          <dd className="flex min-w-0 flex-1 items-baseline justify-end gap-2">
            <span
              className={cn(
                'truncate font-mono text-[12px] tabular-nums',
                value.ok ? 'text-foreground' : 'text-muted-foreground',
              )}
              title={`${value.expr} as ${value.format}`}
            >
              {value.text}
            </span>
            <span className="shrink-0 rounded bg-secondary px-1 font-mono text-[11px] text-muted-foreground">
              {value.format}
            </span>
          </dd>
        </div>
      ))}
      {!live && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          Values come from the running guest. Start a sample to see them.
        </p>
      )}
    </dl>
  )
}

export function TourCard({ board, sampleId }: Props) {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const dts = useSyncExternalStore(dtsStore.subscribe, dtsStore.get, dtsStore.get)
  const card = state.current
  // The tree as the card shows it, without the build's provenance comments.
  const dtsLines = useMemo(() => (dts ? stripDtsProvenance(dts.text.split('\n')) : null), [dts])
  const dtsRanges = useMemo(
    () => resolveHighlightSpecs(card?.step.dts ?? [], dtsLines ?? undefined),
    [card?.step.dts, dtsLines],
  )
  const nextTitle = useTourTitle(state.doc?.next ?? null)

  // Ring the dock rows the step on screen points at for as long as its card is
  // up, and blink them once it has landed. A different card, even the same
  // step's, blinks them again; folding this one to a line does not.
  const onScreen = cardOnScreen(state)
  const shownCard = onScreen?.card ?? null
  const shownStep = onScreen?.step ?? null
  useEffect(() => pointAt(shownStep), [shownCard, shownStep])

  if (!state.enabled) return null
  if (state.intro && state.doc?.intro) {
    return <IntroCard boardId={board.id} sampleId={sampleId} state={state} />
  }
  if (!card) {
    // Between cards: the tour is over, or the reader has something to do.
    if (state.completed && state.doc?.outro) {
      return (
        <CompletionCard
          board={board}
          sampleId={sampleId}
          outro={state.doc.outro}
          next={state.doc.next}
          nextTitle={nextTitle}
        />
      )
    }
    if (state.waiting) {
      return (
        <WaitingCard
          waiting={state.waiting}
          steps={state.doc?.steps ?? []}
          seen={state.seen}
          startedAt={startedAt(state, state.waiting.index)}
          title={state.doc?.title ?? null}
          hasIntro={Boolean(state.doc?.intro)}
        />
      )
    }
    return null
  }

  const {
    step,
    anchor,
    paused,
    values,
    check,
    memory,
    objects,
    registers,
    threads,
    provenance,
  } = card
  const showSource = state.doc?.showSource !== false
  const total = state.doc?.steps.length ?? 0
  const src =
    showSource && card.source
      ? `${import.meta.env.BASE_URL}qemu/${sampleSourceAsset(board, sampleId, card.source)}`
      : null

  const where =
    showSource && anchor
      ? anchor.file && anchor.line
        ? `${provenance?.path ?? baseName(anchor.file)}:${anchor.line}`
        : (anchor.symbol ?? `0x${anchor.addr.toString(16)}`)
      : null

  const startedAtStep = startedAt(state, step.index)
  const minimised = state.minimised !== null && state.minimised === card
  // A step read again only goes back to the card it covers: see next().
  const nextLabel = card.revisit
    ? 'Back'
    : check?.retrying
      ? 'Try again'
      : paused
        ? 'Continue'
        : 'Got it'
  const pausedPill = paused && (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[11px] text-primary-text"
      title={showSource ? 'The guest is paused on this line' : 'The guest is paused'}
    >
      <Pause className="size-2.5" aria-hidden />
      paused
    </span>
  )

  // What the step shows under its prose, by the directive that asks for it. A
  // `{name}` line in the body puts one where the prose talks about it.
  const views: Record<CardView, ReactNode> = {
    watch: values.length > 0 && <Values values={values} live={state.live} />,
    check: check && (
      <CheckResults check={check} pass={step.pass} fail={step.fail} live={state.live} />
    ),
    objects: objects && <TourObjects spec={objects} snap={snap} live={state.live} />,
    memory: memory && <TourHexdump memory={memory} />,
    registers: registers.length > 0 && (
      <div className="flex flex-wrap gap-1.5">
        {registers.map((reg) => (
          <button
            key={reg.name}
            type="button"
            onClick={() => debugUi.focusDebug('cpu')}
            title="Open the CPU registers"
            className="flex items-baseline gap-1.5 rounded border border-border bg-muted/40 px-1.5 py-0.5 hover:border-primary/50"
          >
            <span className="font-mono text-[11px] text-muted-foreground">{reg.name}</span>
            <span className="font-mono text-[12px] tabular-nums text-foreground">{reg.value}</span>
          </button>
        ))}
      </div>
    ),
    threads: threads && (
      <div className="rounded border border-border bg-muted/30 p-1">
        <ThreadsPane
          snap={snap}
          only={step.threadNames}
          compact
          onPeek={() => debugUi.focusDebug('memory')}
        />
      </div>
    ),
    dts: showSource && dts && dtsLines && dtsRanges.length > 0 && (
      <SourceSnippet text={dtsLines.join('\n')} filename={dts.name} language="dts" ranges={dtsRanges} />
    ),
    source: src && anchor?.line && (
      <SourceSnippet
        src={src}
        line={anchor.line}
        ranges={card.highlight}
        // The guest is stopped: names can be read, as VS Code's debug
        // hover reads them. Not on a step read again, which shows an
        // older stop than the one the machine is at.
        inspectable={state.live && snap.gdb && snap.paused && !card.revisit}
      />
    ),
  }
  const placed = placedViews(step.body)

  // The data-tour-* attributes are what the headless playthrough waits on
  // (tools/tour-playthrough.mjs). Steps count from 1, as the card shows them.
  return (
    <TourFrame
      data-tour-step={step.index + 1}
      data-tour-paused={paused ? '' : undefined}
      minimised={minimised}
      header={
        minimised ? (
          // One line: where the tour is, and its one action.
          <>
            <GraduationCap className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {total > 0 ? `${step.index + 1}/${total}` : step.index + 1}
            </span>
            <button
              type="button"
              onClick={restore}
              title="Show the card"
              className="min-w-0 truncate text-left text-[12px] font-medium text-foreground/80 hover:text-foreground"
            >
              <InlineMarkdown text={step.title} />
            </button>
            <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
              {pausedPill}
              <Button size="sm" onClick={next} className="h-6 px-2 text-[11px]">
                {nextLabel}
              </Button>
              <button
                type="button"
                aria-label="Show the card"
                title="Show the card"
                onClick={restore}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className="size-3.5" aria-hidden />
              </button>
            </div>
          </>
        ) : (
          <>
            <GraduationCap className="size-3.5 shrink-0 text-primary" aria-hidden />
            {state.doc && <TourTitle title={state.doc.title} hasIntro={Boolean(state.doc.intro)} />}
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {total > 0 ? `${step.index + 1}/${total}` : step.index + 1}
            </span>
            <TourOutline
              steps={state.doc?.steps ?? []}
              seen={state.seen}
              currentIndex={step.index}
            />
            <div className="ml-auto flex items-center gap-1.5">
              {pausedPill}
              {state.tourId && (
                <CopyTourLink
                  boardId={board.id}
                  sampleId={sampleId}
                  tourId={state.tourId}
                  step={step.index + 1}
                />
              )}
              {/* Out of the way, not onward: the guest stays where it is. */}
              <button
                type="button"
                aria-label="Minimise the card"
                title="Minimise the card (Esc). The tour stays on this step."
                onClick={minimise}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <ChevronUp className="size-3.5" aria-hidden />
              </button>
            </div>
          </>
        )
      }
      footer={
        <>
          <Button size="sm" onClick={next} className="h-7 px-3 text-xs">
            {nextLabel}
          </Button>
          {paused && state.live && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-xs"
              title="Step one instruction, without leaving the step"
              onClick={() => void debug.step()}
            >
              <Redo2 className="size-3" aria-hidden />
              Step
            </Button>
          )}
          {paused && (
            <span className="text-[11px] text-muted-foreground">resumes the guest</span>
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
      bodyClassName="space-y-2.5 px-3 py-2.5"
    >
      <h2 className="text-base font-semibold leading-snug text-foreground">
        <InlineMarkdown text={step.title} />
      </h2>

      {where && (
        <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Bug className="size-3 shrink-0" aria-hidden />
          {/* Whose code this is: a stop in the kernel should not read as the sample's. */}
          {provenance && anchor?.file && anchor.line && (
            <span className="shrink-0">{provenance.origin} ·</span>
          )}
          <span className="truncate text-foreground/80">{where}</span>
          {anchor?.symbol && anchor.file && (
            <span className="truncate">in {anchor.symbol}()</span>
          )}
          {card.hits > 1 && <span>· hit {card.hits}</span>}
        </p>
      )}

      {startedAtStep !== null && <StartedAt step={startedAtStep} />}

      <Markdown body={step.body} runnable paused={paused} className={PROSE} slots={views} />

      {card.lookNotes.map((note) => (
        <p key={note} className="text-[12px] text-muted-foreground">
          {note}
        </p>
      ))}

      {/* The views the prose did not place, in their usual order. */}
      {CARD_VIEWS.filter((view) => !placed.has(view)).map((view) =>
        views[view] ? <Fragment key={view}>{views[view]}</Fragment> : null,
      )}

      {state.problems.length > 0 && (
        <ul className="space-y-0.5 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
          {state.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </TourFrame>
  )
}
