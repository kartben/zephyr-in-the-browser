import type { TourStep } from '@/tours/parse'

/** One outline chapter: a heading plus the steps that follow it. */
export interface ChapterGroup {
  title: string | null
  steps: TourStep[]
}

/** Group steps by `chapter`, preserving file order. */
export function groupStepsByChapter(steps: TourStep[]): ChapterGroup[] {
  const groups: ChapterGroup[] = []
  for (const step of steps) {
    const last = groups[groups.length - 1]
    if (last && last.title === step.chapter) {
      last.steps.push(step)
      continue
    }
    groups.push({ title: step.chapter, steps: [step] })
  }
  return groups
}
