/**
 * Metadata for the sample gallery, from the mirrored documentation.
 *
 * tools/fetch-docs.mjs mirrors each packaged sample's docs page into
 * public/docs/ at deploy time and writes manifest.json beside them, keyed by
 * sample path — exactly `GuestSample.zephyrSample`. public/docs is gitignored,
 * so a dev checkout usually has no manifest: everything here degrades to the
 * hand-tuned label/description from src/boards.ts and the links that can be
 * computed from the sample path alone. When the mirror is present, the gallery
 * prefers the upstream title and description.
 */

import type { GuestSample } from '@/boards'

export interface DocsManifestEntry {
  app: string
  boards: string[]
  title: string
  description: string
  /** Mirrored page, relative to /docs/. */
  local?: string
  canonical?: string
  source?: string
}

export interface DocsManifest {
  generated: string
  samples: Record<string, DocsManifestEntry>
}

let cached: Promise<DocsManifest | null> | undefined

/** Fetch the manifest once; null when it is not served (dev, no docs:fetch). */
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
  /** Mirrored docs page served by this site, when the mirror ran. */
  localHref?: string
  /** The page on docs.zephyrproject.org. */
  canonicalHref?: string
  /** The sample's source tree on GitHub. */
  sourceHref?: string
  /**
   * Display title — Zephyr docs `<h1>` when the mirror has it, otherwise the
   * curated `GuestSample.label`.
   */
  title: string
  /**
   * Display description — Zephyr docs page description when the mirror has it,
   * otherwise the curated `GuestSample.description`.
   */
  description: string
}

/**
 * Links and prose for one sample. The canonical and source links need no
 * manifest — they follow from the sample path — so the gallery has working
 * links even on a bare checkout. Repo-local samples (zephyr-module/*) have no
 * upstream to link to.
 */
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
