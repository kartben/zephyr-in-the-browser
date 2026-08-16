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

import { useMemo, useSyncExternalStore } from 'react'
import { Bug, GraduationCap, Pause, Redo2, X } from 'lucide-react'
import { InlineMarkdown, Markdown } from '@/components/Markdown'
import { SourceSnippet } from '@/components/SourceSnippet'
import { ThreadsPane } from '@/components/debug/ThreadsPane'
import { TourHexdump } from '@/components/tour/TourHexdump'
import { TourObjects } from '@/components/tour/TourObjects'
import { TourOutline } from '@/components/tour/TourOutline'
import { Button } from '@/components/ui/button'
import { sampleSourceAsset, type Board } from '@/boards'
import * as debug from '@/debug/control'
import * as dtsStore from '@/devicetree'
import * as debugUi from '@/lib/debugUi'
import { getSnapshot, next, skip, subscribe, type TourValue } from '@/tours/store'
import { resolveHighlightSpecs } from '@/tours/parse'
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
          <dt className="min-w-0 shrink-0 basis-1/3 truncate text-[11px] text-muted-foreground">
            {value.label}
          </dt>
          <dd className="flex min-w-0 flex-1 items-baseline justify-end gap-2">
            <span
              className={cn(
                'truncate font-mono text-[11.5px] tabular-nums',
                value.ok ? 'text-foreground' : 'text-muted-foreground/70',
              )}
              title={`${value.expr} as ${value.format}`}
            >
              {value.text}
            </span>
            <span className="shrink-0 rounded bg-secondary px-1 font-mono text-[9.5px] text-muted-foreground">
              {value.format}
            </span>
          </dd>
        </div>
      ))}
      {!live && (
        <p className="px-2 py-1 text-[10.5px] text-muted-foreground/80">
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
  const dtsRanges = useMemo(
    () => resolveHighlightSpecs(card?.step.dts ?? [], dts?.text.split('\n')),
    [card?.step.dts, dts?.text],
  )

  if (!card || !state.enabled) return null

  const { step, anchor, paused, values, memory, objects, registers, threads } = card
  const total = state.doc?.steps.length ?? 0
  const src = anchor?.file
    ? `${import.meta.env.BASE_URL}qemu/${sampleSourceAsset(board, sampleId, baseName(anchor.file))}`
    : null

  const where = anchor
    ? anchor.file && anchor.line
      ? `${baseName(anchor.file)}:${anchor.line}`
      : (anchor.symbol ?? `0x${anchor.addr.toString(16)}`)
    : null

  return (
    <div
      data-shot-target="tour"
      className={cn(
        'pointer-events-auto w-full',
        state.doc?.curriculum ? 'max-w-[48rem]' : 'max-w-[34rem]',
      )}
    >
      <div className="rounded-lg border border-primary/40 bg-card/95 shadow-xl backdrop-blur">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <GraduationCap className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
            {state.doc?.curriculum ?? state.doc?.title ?? 'Tour'}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {total > 0 ? `${step.index + 1}/${total}` : step.index + 1}
          </span>
          {!state.doc?.curriculum && (
            <TourOutline
              steps={state.doc?.steps ?? []}
              seen={state.seen}
              currentIndex={step.index}
            />
          )}
          {paused && (
            <span
              className="ml-auto flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary"
              title="The guest is paused on this line"
            >
              <Pause className="size-2.5" aria-hidden />
              paused
            </span>
          )}
          {!paused && step.file && (
            <span
              className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground"
              title="This step shows a build file. The guest is not stopped."
            >
              {step.file}
            </span>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={next}
            className={`${paused || step.file ? '' : 'ml-auto '}rounded p-0.5 text-muted-foreground hover:text-foreground`}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>

        <div
          className={cn(
            'max-h-[min(32rem,68vh)] px-3 py-2.5',
            state.doc?.curriculum && 'flex gap-3',
          )}
        >
          {state.doc?.curriculum && (
            <TourOutline
              named
              steps={state.doc.steps}
              seen={state.seen}
              currentIndex={step.index}
            />
          )}
          <div className="min-w-0 flex-1 space-y-2.5 overflow-y-auto">
          <h2 className="text-sm font-semibold text-foreground">
            <InlineMarkdown text={step.title} />
          </h2>

          {where && (
            <p className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
              <Bug className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{where}</span>
              {anchor?.symbol && anchor.file && (
                <span className="truncate text-muted-foreground/70">in {anchor.symbol}()</span>
              )}
              {card.hits > 1 && <span className="text-muted-foreground/70">· hit {card.hits}</span>}
            </p>
          )}

          <Markdown
            body={step.body}
            className="space-y-2 text-[12.5px] leading-relaxed text-muted-foreground"
          />

          {values.length > 0 && <Values values={values} live={state.live} />}

          {objects && <TourObjects spec={objects} snap={snap} live={state.live} />}

          {memory && <TourHexdump memory={memory} />}

          {registers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {registers.map((reg) => (
                <button
                  key={reg.name}
                  type="button"
                  onClick={() => debugUi.focusDebug('cpu')}
                  title="Open the CPU registers"
                  className="flex items-baseline gap-1.5 rounded border border-border bg-muted/40 px-1.5 py-0.5 hover:border-primary/50"
                >
                  <span className="font-mono text-[10px] text-muted-foreground">{reg.name}</span>
                  <span className="font-mono text-[11px] tabular-nums text-foreground">
                    {reg.value}
                  </span>
                </button>
              ))}
            </div>
          )}

          {threads && (
            <div className="rounded border border-border bg-muted/30 p-1">
              <ThreadsPane snap={snap} onPeek={() => debugUi.focusDebug('memory')} />
            </div>
          )}

          {dts && dtsRanges.length > 0 && (
            <SourceSnippet
              text={dts.text}
              filename={dts.name}
              language="dts"
              ranges={dtsRanges}
            />
          )}

          {src && anchor?.line && (
            <SourceSnippet src={src} line={anchor.line} ranges={card.highlight} />
          )}

          {state.problems.length > 0 && (
            <ul className="space-y-0.5 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[10.5px] text-amber-600 dark:text-amber-400">
              {state.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Button size="sm" onClick={next} className="h-7 px-3 text-xs">
            {paused ? 'Continue' : 'Got it'}
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
        </div>
      </div>
    </div>
  )
}
