import type { GuestSample } from '@/boards'

export interface DocsManifestEntry {
  app: string
  boards: string[]
  title: string
  description: string
  local?: string
  canonical?: string
  source?: string
}

export interface DocsManifest {
  generated: string
  samples: Record<string, DocsManifestEntry>
}

let cached: Promise<DocsManifest | null> | undefined

export function loadDocsManifest(): Promise<DocsManifest | null> {
  cached ??= fetchManifest()
  return cached
}

async function fetchManifest(): Promise<DocsManifest | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}docs/manifest.json`)
    // Unknown paths come back as index.html with a 200 on SPA hosts.
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return null
    const json: unknown = await res.json()
    if (typeof json !== 'object' || json === null) return null
    if (typeof (json as DocsManifest).samples !== 'object') return null
    return json as DocsManifest
  } catch {
    return null
  }
}

export interface SampleDocs {
  localHref?: string
  canonicalHref?: string
  sourceHref?: string
  title: string
  description: string
}

export function sampleDocs(sample: GuestSample, manifest: DocsManifest | null): SampleDocs {
  const path = sample.zephyrSample
  const entry = manifest?.samples[path]
  const docs: SampleDocs = {
    title: entry?.title?.trim() || sample.label,
    description: entry?.description?.trim() || sample.description,
  }
  if (!path.startsWith('zephyr-module/')) {
    docs.canonicalHref = `https://docs.zephyrproject.org/latest/${path}/README.html`
    docs.sourceHref = `https://github.com/zephyrproject-rtos/zephyr/tree/main/${path}`
  }
  if (entry?.local) docs.localHref = `${import.meta.env.BASE_URL}docs/${entry.local}`
  return docs
}
