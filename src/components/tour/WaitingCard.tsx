/**
 * The card between two stops when getting to the next one is up to the reader.
 *
 * Continue cannot reach a step with `await:`: the guest runs on, and something
 * has to happen first, a press of SW0 or a shell command. Without this card
 * the page went quiet at exactly the moment the reader was meant to act. It
 * does not pause anything, and the step's own card replaces it when the guest
 * gets there.
 */

import { GraduationCap, Hand } from 'lucide-react'
import { Markdown } from '@/components/Markdown'
import { ShellSnippet } from '@/components/tour/ShellSnippet'
import { TourOutline } from '@/components/tour/TourOutline'
import type { TourStep } from '@/tours/parse'
import { skip, type TourWaiting } from '@/tours/store'

interface Props {
  waiting: TourWaiting
  steps: TourStep[]
  seen: Set<number>
}

export function WaitingCard({ waiting, steps, seen }: Props) {
  const total = steps.length
  return (
    // data-tour-*: the step this card waits on, for the headless playthrough.
    <div
      className="pointer-events-auto w-full max-w-[34rem]"
      data-tour-step={waiting.index + 1}
      data-tour-waiting=""
    >
      <div className="rounded-lg border border-primary/40 bg-card/95 shadow-xl backdrop-blur">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <GraduationCap className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {total > 0 ? `${waiting.index + 1}/${total}` : waiting.index + 1}
          </span>
          <TourOutline steps={steps} seen={seen} currentIndex={waiting.index} />
          <span
            className="ml-auto flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary"
            title="The guest keeps running while you do this"
          >
            <Hand className="size-2.5" aria-hidden />
            your turn
          </span>
        </div>

        <div className="space-y-2 px-3 py-2.5">
          <Markdown
            body={waiting.text}
            className="space-y-2 text-[12.5px] leading-relaxed text-foreground"
          />
          {/* The guest is running here, so Run types straight away. */}
          {waiting.do.length > 0 && <ShellSnippet lines={waiting.do} />}
          {waiting.notes.map((note) => (
            <p key={note} className="text-[11px] text-muted-foreground/80">
              {note}
            </p>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            The tour picks up at the next stop.
          </span>
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
