/**
 * The card a tour ends on.
 *
 * A tour used to finish in silence: the last card went and nothing came after
 * it. One with an outro (a last `##` section with no ```tour block) ends here,
 * with a way to take it again and, when it names a `next:` tour, a way on.
 * Leaving the tour early still says nothing more. This is for readers who got
 * to the end.
 */

import { useEffect, useState } from 'react'
import { ArrowRight, GraduationCap, RotateCcw, X } from 'lucide-react'
import { InlineMarkdown, Markdown, PROSE } from '@/components/Markdown'
import { TourFrame } from '@/components/tour/TourFrame'
import { Button } from '@/components/ui/button'
import { getSample, type Board } from '@/boards'
import { runCommand } from '@/lib/commands'
import { selectSample } from '@/lib/selection'
import { nextSampleId } from '@/tours/catalog'
import type { TourOutro } from '@/tours/parse'
import { dismissCompletion, fetchTour } from '@/tours/store'

/**
 * Another tour's title, once its file has loaded. Asked for as soon as the
 * running tour names it, so the Next button has it long before the end.
 */
export function useTourTitle(id: string | null): string | null {
  const [loaded, setLoaded] = useState<{ id: string; title: string } | null>(null)
  useEffect(() => {
    if (!id) return
    let live = true
    void fetchTour(id).then((doc) => {
      if (live && doc) setLoaded({ id, title: doc.title })
    })
    return () => {
      live = false
    }
  }, [id])
  return loaded?.id === id ? loaded.title : null
}

interface Props {
  board: Board
  sampleId: string
  outro: TourOutro
  /** The tour id `next:` names, if any. */
  next: string | null
  /** Its title, once loaded; the app's label stands in until then. */
  nextTitle: string | null
}

export function CompletionCard({ board, sampleId, outro, next, nextTitle }: Props) {
  // Next stays on this board; with no such app here there is nowhere to go.
  const target = next ? nextSampleId(board, sampleId, next) : null
  const title = target ? (nextTitle ?? getSample(board, target).label) : null

  return (
    // data-tour-complete: the headless playthrough's sign that the tour ended.
    <TourFrame
      data-tour-complete=""
      header={
        <>
          <GraduationCap className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="text-[11px] text-muted-foreground">Tour complete</span>
          <button
            type="button"
            aria-label="Close"
            onClick={dismissCompletion}
            className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </>
      }
      footer={
        <>
          {target && title && (
            <Button
              size="sm"
              onClick={() => selectSample({ sampleId: target, tourId: next ?? undefined })}
              title={`Open ${getSample(board, target).label} and start its tour`}
              className="h-7 min-w-0 px-3 text-xs"
            >
              <span className="truncate">Next: {title}</span>
              <ArrowRight className="size-3" aria-hidden />
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => runCommand('restart')}
            title="Restart the sample and take the tour from the top"
            className="h-7 shrink-0 px-2 text-xs"
          >
            <RotateCcw className="size-3" aria-hidden />
            Run it again
          </Button>
        </>
      }
      bodyClassName="space-y-2.5 px-3 py-2.5"
    >
      <h2 className="text-base font-semibold leading-snug text-foreground">
        <InlineMarkdown text={outro.title} />
      </h2>
      <Markdown body={outro.body} className={PROSE} />
    </TourFrame>
  )
}
