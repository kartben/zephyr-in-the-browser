/**
 * What a tour is called.
 *
 * A tour id is its file name without `.tour.md`. `tours/basic_button.tour.md`
 * is `basic_button`, the app's default tour; `tours/basic_button.msgq.tour.md`
 * is `basic_button.msgq`, another tour of the same app. The app is in the name,
 * so finding an app's tours opens no file, and a link that names a tour also
 * names the sample it runs on.
 *
 * Kept apart from catalog.ts, which bundles the tours themselves: the parser
 * checks `next:` against this grammar and must not pull them in to do it.
 */

/** `?tour=none`: boot the sample with no tour, and so with nothing frozen. */
export const NO_TOUR = 'none'

/** `<app>` or `<app>.<slug>`: word characters and hyphens, one dot at most. */
const TOUR_ID = /^\w[\w-]*(?:\.\w[\w-]*)?$/

/** True when `id` has the shape of a tour id. Whether that tour exists is catalog.ts's question. */
export function isTourId(id: string): boolean {
  return TOUR_ID.test(id)
}

/** The app a tour runs on: the id up to its dot. */
export function appOfTour(id: string): string {
  const dot = id.indexOf('.')
  return dot === -1 ? id : id.slice(0, dot)
}
