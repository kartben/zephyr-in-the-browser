/**
 * Where the reader is in the tour.
 *
 * Short tours keep the dot strip. A curriculum (named chapters, many steps)
 * gets a list: chapter headings, step titles, seen / current / locked.
 */

import { revisit } from '@/tours/store'
import { groupStepsByChapter } from '@/tours/chapters'
import type { TourStep } from '@/tours/parse'
import { cn } from '@/lib/utils'

interface Props {
  steps: TourStep[]
  seen: Set<number>
  currentIndex: number | null
  /** Named chapter list. Default is the compact dot strip. */
  named?: boolean
}

export function TourOutline({ steps, seen, currentIndex, named = false }: Props) {
  if (steps.length < 2) return null
  if (named) {
    return (
      <NamedOutline steps={steps} seen={seen} currentIndex={currentIndex} />
    )
  }

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
            className={cn(
              'h-1.5 rounded-full transition-all',
              isCurrent ? 'w-5 bg-primary' : 'w-1.5',
              !isCurrent && isSeen && 'bg-primary/50 hover:bg-primary/80',
              !isSeen && 'bg-muted-foreground/25',
            )}
          />
        )
      })}
    </div>
  )
}

function NamedOutline({ steps, seen, currentIndex }: Omit<Props, 'named'>) {
  const groups = groupStepsByChapter(steps)
  return (
    <nav
      aria-label="Curriculum steps"
      className="flex min-w-[11.5rem] flex-col gap-1.5 pr-1"
    >
      {groups.map((group, gi) => (
        <div key={group.title ?? `group-${gi}`}>
          {group.title && (
            <p className="mb-0.5 px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
            </p>
          )}
          <ol>
            {group.steps.map((step) => {
              const isCurrent = step.index === currentIndex
              const isSeen = seen.has(step.index)
              return (
                <li key={step.index}>
                  <button
                    type="button"
                    aria-current={isCurrent ? 'step' : undefined}
                    disabled={!isSeen}
                    title={step.title}
                    onClick={() => revisit(step.index)}
                    className={cn(
                      'flex w-full items-baseline gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] leading-snug',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isCurrent && 'bg-primary/15 text-foreground',
                      !isCurrent && isSeen && 'text-foreground/80 hover:bg-secondary',
                      !isSeen && 'cursor-default text-muted-foreground/45',
                    )}
                  >
                    <span className="w-4 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                      {step.index + 1}
                    </span>
                    <span className="min-w-0 truncate">{step.title}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      ))}
    </nav>
  )
}
