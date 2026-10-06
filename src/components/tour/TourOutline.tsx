/**
 * Where the reader is in the tour.
 *
 * One dot per step the tour file declares — unlike the old walkthrough, whose
 * outline could only be drawn from what the firmware announced at boot, the
 * shape of a tour is known before the guest starts. Steps already seen are
 * clickable, to read a note again without rewinding anything.
 */

import { revisit } from '@/tours/store'
import type { TourStep } from '@/tours/parse'
import { cn } from '@/lib/utils'

interface Props {
  steps: TourStep[]
  seen: Set<number>
  currentIndex: number | null
}

export function TourOutline({ steps, seen, currentIndex }: Props) {
  if (steps.length < 2) return null

  return (
    <div className="flex items-center gap-1" role="list" aria-label="Tour steps">
      {steps.map((step) => {
        const isCurrent = step.index === currentIndex
        const isSeen = seen.has(step.index)
        const label = `Step ${step.index + 1}: ${step.title}`
        return (
          <button
            key={step.index}
            type="button"
            role="listitem"
            title={label}
            aria-label={label}
            aria-current={isCurrent ? 'step' : undefined}
            disabled={!isSeen}
            onClick={() => revisit(step.index)}
            // Each state at 3:1 or more against the card: the step the tour is
            // on a pill, steps already shown filled, the rest an outline.
            className={cn(
              'h-1.5 rounded-full transition-all motion-reduce:transition-none',
              isCurrent ? 'w-5 bg-primary' : 'w-1.5',
              !isCurrent && isSeen && 'bg-muted-foreground hover:bg-foreground',
              !isSeen && 'ring-1 ring-inset ring-muted-foreground',
            )}
          />
        )
      })}
    </div>
  )
}
