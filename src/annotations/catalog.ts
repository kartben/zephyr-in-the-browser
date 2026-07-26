/**
 * The prose half of an annotated sample.
 *
 * The build ships `<app>.annotations.json` next to `<app>.elf`, holding
 * everything the guest deliberately does not carry: titles, Markdown bodies,
 * which panel each annotation is about, and where in the source it points.
 * The firmware only ever sends ids, and this is what turns one back into a
 * popup.
 *
 * Absence is a supported state throughout. A sample with no annotations has no
 * JSON, an older image tarball has none either, and a user-dropped ELF has
 * nothing to look up — in all three the walkthrough simply never starts.
 */

/** One annotation as authored. */
export interface CatalogEntry {
  id: number
  key: string
  title: string
  /** Markdown; see markdown.ts for the subset. */
  body: string
  /** A PanelKind the device dock should reveal, when the author named one. */
  panel?: string
  /** Index into `files`. */
  file: number
  /** Line in the *stripped* source — the copy shipped for display. */
  line: number
  /** Where the SAMPLE_SHOW*() calls sit, so the viewer can dim them. */
  fireSites: Array<{ file: number; line: number }>
}

export interface AnnotationCatalog {
  version: number
  app: string
  /** Source paths, relative to the shipped `src/<app>/` directory. */
  files: string[]
  byId: Map<number, CatalogEntry>
  /** Authored order, which is also source order. */
  entries: CatalogEntry[]
}

const CATALOG_VERSION = 1

function isEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.id === 'number' &&
    typeof e.key === 'string' &&
    typeof e.title === 'string' &&
    typeof e.body === 'string' &&
    typeof e.file === 'number' &&
    typeof e.line === 'number'
  )
}

function build(raw: unknown): AnnotationCatalog | null {
  if (typeof raw !== 'object' || raw === null) return null
  const doc = raw as Record<string, unknown>
  if (doc.version !== CATALOG_VERSION) return null
  if (!Array.isArray(doc.files) || !Array.isArray(doc.annotations)) return null

  const entries = doc.annotations.filter(isEntry).map((e) => ({
    ...e,
    fireSites: Array.isArray(e.fireSites) ? e.fireSites : [],
  }))
  if (entries.length === 0) return null

  return {
    version: CATALOG_VERSION,
    app: typeof doc.app === 'string' ? doc.app : '',
    files: doc.files.filter((f): f is string => typeof f === 'string'),
    byId: new Map(entries.map((e) => [e.id, e])),
    entries,
  }
}

/*
 * Cached by URL, misses included: a sample with no annotations is as cacheable
 * as one with them, and StrictMode's double mount reuses the first answer
 * either way. Same shape as the .dts cache in src/devicetree.ts.
 */
const cache = new Map<string, AnnotationCatalog | null>()

/**
 * Fetch a sample's annotation catalog. Never throws — a missing file, a dev
 * server answering with index.html, or a malformed document all read as "this
 * sample is not annotated".
 */
export async function loadCatalog(assetUrl: string): Promise<AnnotationCatalog | null> {
  const cached = cache.get(assetUrl)
  if (cached !== undefined) return cached

  let catalog: AnnotationCatalog | null = null
  try {
    const res = await fetch(assetUrl)
    // Vite and GitHub Pages both answer an unknown path with index.html and a
    // 200, so res.ok alone would hand us an HTML shell to parse as JSON.
    if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) {
      catalog = build(await res.json())
    }
  } catch {
    // Absence and network failure are the same thing here.
  }
  cache.set(assetUrl, catalog)
  return catalog
}
