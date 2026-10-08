/**
 * What the query string asks the page to run.
 *
 * The selection lives in the URL so it survives the reload a committed QEMU
 * session needs, and so a link can name a board, an app, one of the app's
 * tours, and the step to start that tour at. Pure, so the rules are testable
 * without a page.
 */

import { BOARDS, DEFAULT_BOARD_ID, getBoard, getSample } from '@/boards'
import type { BackendId } from '@/backends/types'
import { baseSampleId, sampleForTour, tourToRun } from '@/tours/catalog'
import { appOfTour, isTourId, NO_TOUR } from '@/tours/tourId'

export interface Selection {
  boardId: string
  sampleId: string
  backendId: BackendId
  /**
   * `?tour=`: a tour id, `none` for a run with no tour, or null for the
   * sample's default tour. Not checked against the sample here; tourToRun in
   * src/tours/catalog.ts decides what actually runs.
   */
  tour: string | null
  /** `?step=`: the step to start the tour at, counted from 1 as the card counts. */
  step: number | null
}

/** A tour as the URL names it, or null when it names none or a malformed one. */
function readTour(value: string | null): string | null {
  if (value === null) return null
  return value === NO_TOUR || isTourId(value) ? value : null
}

/** A step number, counted from 1. Anything else (`0`, `-1`, `2.5`, `three`) is no step. */
function readStep(value: string | null): number | null {
  return value !== null && /^[1-9]\d*$/.test(value) ? Number(value) : null
}

/**
 * Read the selection out of a query string. `fallbackBackend` stands in when
 * the URL names no backend, or one that does not exist.
 */
export function parseSelection(search: string, fallbackBackend: BackendId): Selection {
  const params = new URLSearchParams(search)
  const board = params.get('board')
  const backend = params.get('backend')
  const boardId = BOARDS.some((b) => b.id === board) ? board! : DEFAULT_BOARD_ID
  const resolved = getBoard(boardId)
  const tour = readTour(params.get('tour'))
  // A tour names its app, so a link that names only a tour runs that app,
  // when this board has it.
  const tourApp = tour !== null && tour !== NO_TOUR ? appOfTour(tour) : null
  const app =
    params.get('app') ??
    (tourApp !== null && resolved.samples.some((s) => s.id === tourApp) ? tourApp : null)
  const asked = getSample(resolved, app ?? resolved.defaultSampleId).id
  return {
    boardId,
    // A tour that points at Trace boots the sample's traced build.
    sampleId: sampleForTour(resolved, asked, tourToRun(resolved, asked, tour)),
    backendId: backend === 'mock' || backend === 'qemu' ? backend : fallbackBackend,
    tour,
    step: readStep(params.get('step')),
  }
}

/**
 * The `?tour=` that survives a change of sample or board that names no tour,
 * such as a pick in the app picker. A tour belongs to one app, and so does a
 * clean run (`none`): either is kept only while the app stays the same.
 */
export function carryTour(tour: string | null, from: string, to: string): string | null {
  if (tour === null) return null
  const app = baseSampleId(to)
  if (tour === NO_TOUR) return baseSampleId(from) === app ? tour : null
  return appOfTour(tour) === app ? tour : null
}

/**
 * A link that opens a tour at a step, and says nothing else: `?board=`,
 * `?app=`, `?tour=`, and `?step=` past the first step. No backend or mode, so
 * whoever opens it gets their own page's defaults.
 */
export function tourLink(
  base: string,
  at: { boardId: string; sampleId: string; tourId: string; step: number },
): string {
  const params = new URLSearchParams({ board: at.boardId, app: at.sampleId, tour: at.tourId })
  if (at.step > 1) params.set('step', String(at.step))
  return `${base}?${params}`
}
