import { revisit } from '@/annotations/store'
import type { AnnotationCatalog } from '@/annotations/catalog'
import { cn } from '@/lib/utils'

interface Props {
  outline: number[]
  seen: Set<number>
  currentId: number | null
  catalog: AnnotationCatalog | null
}

export function WalkthroughOutline({ outline, seen, currentId, catalog }: Props) {
  if (outline.length < 2) return null

  return (
    <div className="flex items-center gap-1" role="list" aria-label="Walkthrough steps">
      {outline.map((id, index) => {
        const isCurrent = id === currentId
        const isSeen = seen.has(id)
        const title = catalog?.byId.get(id)?.title
        const label = `Step ${index + 1}${title ? `: ${title}` : ''}`
        return (
          <button
            key={id}
            type="button"
            role="listitem"
            title={label}
            aria-label={label}
            aria-current={isCurrent ? 'step' : undefined}
            disabled={!isSeen}
            onClick={() => revisit(id)}
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
