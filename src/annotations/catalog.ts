export interface CatalogEntry {
  id: number
  key: string
  title: string
  body: string
  panel?: string
  file: number
  line: number
  // SAMPLE_SHOW*() lines, dimmed in snippets; pause mirrors firmware pauses.
  fireSites: Array<{ file: number; line: number; pause?: boolean }>
}

export interface AnnotationCatalog {
  version: number
  app: string
  files: string[]
  byId: Map<number, CatalogEntry>
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

// Cache misses too; most samples have no annotations.
const cache = new Map<string, AnnotationCatalog | null>()

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
    // Missing catalog means this sample is unannotated.
  }
  cache.set(assetUrl, catalog)
  return catalog
}
