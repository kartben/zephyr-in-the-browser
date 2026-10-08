/**
 * Links into a tour: the card header's button that copies one, and the note a
 * card carries when a link started the tour part-way through.
 *
 * A link is `?board=&app=&tour=&step=` (src/lib/selectionParams.ts), which is
 * how a workshop invite, a slide or the docs widget points at one stop of one
 * tour.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Link2, SkipForward } from 'lucide-react'
import { tourLink } from '@/lib/selectionParams'
import type { TourState } from '@/tours/store'

interface LinkProps {
  boardId: string
  sampleId: string
  tourId: string
  /** The step to link to, counted from 1 as the card counts. */
  step: number
}

/** Copies a link that opens this tour at this step, on this board and app. */
export function CopyTourLink({ boardId, sampleId, tourId, step }: LinkProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const url = tourLink(`${location.origin}${location.pathname}`, {
      boardId,
      sampleId,
      tourId,
      step,
    })
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        /* the address bar still has the board and app */
      })
  }
  return (
    <button
      type="button"
      aria-label={copied ? t('tour.link.copied') : t('tour.link.copy')}
      title={copied ? t('tour.link.copied') : t('tour.link.copyTitle')}
      onClick={copy}
      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-success" aria-hidden />
      ) : (
        <Link2 className="size-3.5" aria-hidden />
      )}
    </button>
  )
}

/**
 * The step to say a link started the tour at, on the card for step `index`,
 * or null. Only a tour started part-way says it, and only on the first card
 * the reader sees: no step before this one has been shown.
 */
export function startedAt(
  state: Pick<TourState, 'startIndex' | 'seen'>,
  index: number,
): number | null {
  if (state.startIndex === 0) return null
  for (const shown of state.seen) if (shown < index) return null
  return state.startIndex + 1
}

/** Says that a link started the tour at `step` (counted from 1), skipping the ones before. */
export function StartedAt({ step }: { step: number }) {
  const { t } = useTranslation()
  return (
    <p
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      title={t('tour.link.startedAtTitle')}
    >
      <SkipForward className="size-3 shrink-0" aria-hidden />
      {t('tour.link.startedAt', { step })}
    </p>
  )
}
