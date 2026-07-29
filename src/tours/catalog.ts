/**
 * Which tours exist, and how to get one.
 *
 * Tours ship **with the page**, not with the guest images. That is not an
 * implementation detail — it is the whole difference between a tour and the
 * annotation system it replaced. A tour is Markdown in this repository; the
 * image tarball is a ~100 MB containerised Zephyr build published as a release
 * asset and pinned by a repository variable. Coupling the two meant a tour
 * could not appear until somebody rebuilt Zephyr, and a deploy whose images
 * predated the feature showed nothing at all, with no way to tell that from a
 * sample that simply has no tour.
 *
 * `import.meta.glob` settles it at build time: the tours are part of the
 * bundle, so a sample that has one always has one.
 *
 * The sample's *sources* still come from the image build — they are Zephyr tree
 * files, not ours to ship — and their absence is a supported state that costs
 * the source excerpt and any `at:` pattern that needs the text to search.
 */

const MODULES = import.meta.glob('/tours/*.tour.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

function idOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace('.tour.md', '')
}

/**
 * A CTF-traced twin runs the same sources as the sample it was expanded from,
 * so it reads the same tour.
 */
export function baseSampleId(sampleId: string): string {
  return sampleId.replace(/_trace$/, '')
}

/** Every sample id with a tour, from the files themselves. */
export function tourIds(): string[] {
  return Object.keys(MODULES).map(idOf).sort()
}

/** True when this sample has a tour — no list to keep in step with anything. */
export function hasTour(sampleId: string): boolean {
  return MODULES[`/tours/${baseSampleId(sampleId)}.tour.md`] !== undefined
}

/** The tour's Markdown, or null when the sample has none. */
export async function loadTourSource(sampleId: string): Promise<string | null> {
  const load = MODULES[`/tours/${baseSampleId(sampleId)}.tour.md`]
  if (!load) return null
  try {
    return await load()
  } catch {
    // A chunk that will not load reads the same as no tour.
    return null
  }
}
