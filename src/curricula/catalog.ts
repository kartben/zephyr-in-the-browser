/**
 * Curricula the Learn tab can start. Separate from the sample-tour glob:
 * a path can exist before its capstone app is packaged.
 */

import { parseTour, type TourDoc } from '@/tours/parse'
import envNodeSource from './env_node.tour.md?raw'

export interface Curriculum {
  id: string
  title: string
  /** One line of stakes. Every curriculum card uses this the same way. */
  stakes: string
  /** Gallery sample to boot when packaged. Null until the ELF exists. */
  sampleId: string | null
  source: string
}

export const CURRICULA: Curriculum[] = [
  {
    id: 'env_node',
    title: 'Environmental node',
    stakes: 'Read the air, stamp it, show it, serve it.',
    sampleId: null,
    source: envNodeSource,
  },
]

export function getCurriculum(id: string): Curriculum | undefined {
  return CURRICULA.find((item) => item.id === id)
}

export function loadCurriculumTour(id: string): TourDoc | null {
  const item = getCurriculum(id)
  if (!item) return null
  const doc = parseTour(item.source)
  return doc.steps.length > 0 ? doc : null
}
