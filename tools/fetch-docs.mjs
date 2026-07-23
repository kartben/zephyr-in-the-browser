#!/usr/bin/env node
/**
 * Mirrors the documentation page of every sample in tools/samples.manifest
 * from docs.zephyrproject.org into public/docs/, so the deployed site serves
 * them itself under /docs/. Each page gets a "Run in simulator" widget
 * injected next to the stock "Browse source code on GitHub" button.
 *
 * Why not `wget --mirror`: Sphinx cache-busts every asset (`theme.css?v=…`),
 * and wget keeps the query string in the *filename*, which no static host
 * resolves. This script strips queries, walks CSS url() requisites (fonts,
 * icons), and rewrites links so that pages inside the mirrored subset stay
 * local while everything else points at the live docs absolutely.
 *
 * Downloads go through curl rather than fetch(): Node's fetch ignores
 * HTTPS_PROXY, curl honours it.
 *
 * Usage:  node tools/fetch-docs.mjs     (or: npm run docs:fetch)
 * Output: public/docs/                  (committed; regenerate to refresh)
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(repoRoot, 'public', 'docs')
const WIDGET_SRC = path.join(repoRoot, 'tools', 'docs-widget')
const DOCS_ORIGIN = 'https://docs.zephyrproject.org'
const DOCS_BASE = `${DOCS_ORIGIN}/latest/`
const MIRROR_DATE = new Date().toISOString().slice(0, 10)

/** Subresource types worth mirroring; anything else links to the live site. */
const ASSET_EXTS = new Set([
  'css', 'js', 'mjs', 'map',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp4', 'webm',
])

// ---------------------------------------------------------------------------
// Which pages to mirror, straight from the samples manifest.

/** @type {Map<string, {samplePath: string, boards: string[]}>} */
const samples = new Map()
for (const line of readFileSync(path.join(repoRoot, 'tools', 'samples.manifest'), 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const [board, , samplePath] = trimmed.split(':')
  const entry = samples.get(samplePath) ?? { samplePath, boards: [] }
  if (!entry.boards.includes(board)) entry.boards.push(board)
  samples.set(samplePath, entry)
}
// app_id can differ per board in principle; in practice it is the same for a
// given sample path, so take it from the first matching manifest line.
for (const line of readFileSync(path.join(repoRoot, 'tools', 'samples.manifest'), 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const [, app, samplePath] = trimmed.split(':')
  const entry = samples.get(samplePath)
  if (entry && !entry.app) entry.app = app
}

/**
 * The board the widget boots by default. Cortex-M3 matches the app's own
 * default board where the sample supports it (and is where the shell's
 * host-GPIO bridge lives); graphics-heavy samples only exist on the A53.
 * The emulator's top bar still lets the user switch afterwards.
 */
function defaultBoard(boards) {
  return boards.includes('qemu_cortex_m3') ? 'qemu_cortex_m3' : boards[0]
}

/** '/latest/samples/hello_world/README.html' -> 'samples/hello_world/README.html' */
const clonedPages = new Map(
  [...samples.keys()].map((p) => [`/latest/${p}/README.html`, `${p}/README.html`]),
)

// ---------------------------------------------------------------------------
// Download plumbing.

function fetchBytes(url) {
  return execFileSync('curl', ['-sS', '--fail', '-L', '--retry', '3', url], {
    maxBuffer: 256 * 1024 * 1024,
  })
}

/** localRel -> absolute URL, filled while rewriting pages, drained after. */
const assetQueue = new Map()

/** Queue a docs.zephyrproject.org/latest/ asset; returns its OUT-relative path. */
function queueAsset(abs) {
  const localRel = abs.pathname.slice('/latest/'.length)
  if (!assetQueue.has(localRel)) assetQueue.set(localRel, `${DOCS_ORIGIN}${abs.pathname}`)
  return localRel
}

function extOf(pathname) {
  const base = pathname.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Rewrite one URL found in a mirrored file.
 * @param raw       attribute/url() value as it appears in the source
 * @param baseUrl   URL of the file containing the reference
 * @param fromDir   OUT-relative posix dir of that file ('' for OUT itself)
 */
function mapUrl(raw, baseUrl, fromDir) {
  if (/^(#|data:|mailto:|javascript:|about:)/i.test(raw)) return raw
  let abs
  try {
    abs = new URL(raw, baseUrl)
  } catch {
    return raw
  }
  if (abs.origin !== DOCS_ORIGIN) return raw

  const cloned = clonedPages.get(abs.pathname)
  if (cloned) return path.posix.relative(fromDir, cloned) + abs.hash

  if (abs.pathname.startsWith('/latest/') && ASSET_EXTS.has(extOf(abs.pathname))) {
    return path.posix.relative(fromDir, queueAsset(abs))
  }
  // Everything else — other doc pages, search, genindex — goes to the live site.
  return abs.href
}

function rewriteHtml(html, pageUrl, pageDir) {
  html = html.replace(
    /(\s(?:href|src|poster|action)\s*=\s*")([^"]*)(")/g,
    (_, pre, url, post) => pre + mapUrl(url, pageUrl, pageDir) + post,
  )
  html = html.replace(/(\ssrcset\s*=\s*")([^"]*)(")/g, (_, pre, val, post) => {
    const rewritten = val
      .split(',')
      .map((part) => {
        const [url, ...descriptor] = part.trim().split(/\s+/)
        return [mapUrl(url, pageUrl, pageDir), ...descriptor].join(' ')
      })
      .join(', ')
    return pre + rewritten + post
  })

  // The theme's inline search script re-targets the form at runtime with
  // page-relative URLs ("../../search.html"); those pages are not mirrored,
  // so send searches to the live docs instead.
  html = html.replace(/"(\.\.\/)+(gsearch|search|genindex)\.html"/g, `"${DOCS_BASE}$2.html"`)

  // Drop the Kapa AI assistant: it is keyed to docs.zephyrproject.org, and a
  // cross-origin script without CORP would be blocked by COEP here anyway.
  // The theme's own hasKapaSearch flag cleanly disables the search hook, and
  // the script tolerates the missing menu item.
  html = html.replace(/<script async src="https:\/\/widget\.kapa\.ai[\s\S]*?<\/script>\n?/, '')
  html = html.replace('var hasKapaSearch = true;', 'var hasKapaSearch = false;')
  html = html.replace(/<li id="search-se-menuitem-kapa"[\s\S]*?<\/li>\n?/, '')

  return html
}

/**
 * dark-mode-toggle.min.mjs hardcodes its icon URLs on googlechromelabs.github.io,
 * which COEP would block. Inline them as data: URIs — depth-independent, unlike
 * a relative path resolved from shadow-DOM CSS.
 */
function inlineDarkModeToggleIcons(js) {
  const MIME = { png: 'image/png', svg: 'image/svg+xml' }
  return js.replace(/url\("\$\{W\}([a-z]+\.(png|svg))"\)/g, (match, file, ext) => {
    try {
      const bytes = fetchBytes(`https://googlechromelabs.github.io/dark-mode-toggle/demo/${file}`)
      return `url("data:${MIME[ext]};base64,${bytes.toString('base64')}")`
    } catch (err) {
      console.warn(`  WARN: could not inline dark-mode-toggle icon ${file}: ${err.message}`)
      return match
    }
  })
}

function rewriteCss(css, cssUrl, cssDir) {
  css = css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g, (_, quote, url) => {
    // Fonts carry `?v=…` and `#iefix` suffixes; strip them for the local file.
    const bare = url.split(/[?#]/)[0]
    return `url(${quote}${mapUrl(bare, cssUrl, cssDir)}${quote})`
  })
  css = css.replace(/@import\s+(['"])([^'"]+)\1/g, (_, quote, url) => {
    return `@import ${quote}${mapUrl(url.split(/[?#]/)[0], cssUrl, cssDir)}${quote}`
  })
  return css
}

// ---------------------------------------------------------------------------
// Widget injection.

function injectionFor(samplePath, entry, title) {
  const pageDir = samplePath // OUT-relative dir of the page
  const toDocsRoot = path.posix.relative(pageDir, '.') || '.'
  const toSiteRoot = `${toDocsRoot}/..`
  const config = {
    app: entry.app,
    board: defaultBoard(entry.boards),
    boards: entry.boards,
    title,
    simRoot: `${toSiteRoot}/`,
    canonical: `${DOCS_BASE}${samplePath}/README.html`,
    mirrored: MIRROR_DATE,
  }
  return [
    '<!-- zephyr-in-the-browser: run-in-simulator widget -->',
    `<link rel="stylesheet" href="${toDocsRoot}/_sim/widget.css"/>`,
    `<script>window.ZEPHYR_SIM = ${JSON.stringify(config)}</script>`,
    `<script defer src="${toDocsRoot}/_sim/widget.js"></script>`,
    // The emulator iframe needs SharedArrayBuffer, which only exists when the
    // *top-level* document is cross-origin isolated. Static hosts cannot send
    // COOP/COEP, so the docs pages join the same service-worker workaround the
    // app itself uses (a no-op wherever the headers already arrive).
    `<script src="${toSiteRoot}/coi-serviceworker.js"></script>`,
  ].join('\n')
}

function extractTitle(html) {
  const h1 = html.match(/<h1>([^<]+)</)
  return h1 ? h1[1].trim() : 'Zephyr sample'
}

function extractDescription(html) {
  const ld = html.match(/"description":\s*"((?:[^"\\]|\\.)*)"/)
  if (!ld) return ''
  try {
    return JSON.parse(`"${ld[1]}"`)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Main.

console.log(`Mirroring ${samples.size} sample pages from ${DOCS_BASE} ...`)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const indexEntries = []

for (const [samplePath, entry] of samples) {
  const pageUrl = `${DOCS_BASE}${samplePath}/README.html`
  process.stdout.write(`  ${samplePath} ... `)
  let html = fetchBytes(pageUrl).toString('utf8')

  const title = extractTitle(html)
  const description = extractDescription(html)
  html = rewriteHtml(html, pageUrl, samplePath)
  html = html.replace('</head>', `${injectionFor(samplePath, entry, title)}\n</head>`)

  const outFile = path.join(OUT, samplePath, 'README.html')
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, html)
  indexEntries.push({ samplePath, entry, title, description })
  console.log(`ok (${title})`)
}

// Drain the asset queue; CSS files can add more (fonts, icons) as they land.
let downloaded = 0
while (assetQueue.size > 0) {
  const [localRel, url] = assetQueue.entries().next().value
  assetQueue.delete(localRel)
  const outFile = path.join(OUT, localRel)
  let bytes
  try {
    bytes = fetchBytes(url)
  } catch (err) {
    console.warn(`  WARN: failed to fetch ${url}: ${err.message}`)
    continue
  }
  if (localRel.endsWith('.css')) {
    const cssDir = path.posix.dirname(localRel)
    bytes = Buffer.from(rewriteCss(bytes.toString('utf8'), url, cssDir))
  }
  if (localRel.endsWith('dark-mode-toggle.min.mjs')) {
    bytes = Buffer.from(inlineDarkModeToggleIcons(bytes.toString('utf8')))
  }
  mkdirSync(path.dirname(outFile), { recursive: true })
  writeFileSync(outFile, bytes)
  downloaded++
}
console.log(`Downloaded ${downloaded} asset files.`)

cpSync(WIDGET_SRC, path.join(OUT, '_sim'), { recursive: true })

// ---------------------------------------------------------------------------
// Landing page for /docs/: one card per mirrored sample.

const BOARD_LABELS = { qemu_cortex_m3: 'Cortex-M3', qemu_cortex_a53: 'Cortex-A53' }

const cards = indexEntries
  .map(({ samplePath, entry, title, description }) => {
    const board = defaultBoard(entry.boards)
    const chips = entry.boards
      .map((b) => `<span class="chip">${BOARD_LABELS[b] ?? b}</span>`)
      .join('')
    const runUrl = `../?board=${board}&app=${entry.app}`
    return `      <article class="card">
        <h2><a href="${samplePath}/README.html">${title}</a></h2>
        <p>${description}</p>
        <div class="meta">${chips}</div>
        <div class="actions">
          <a class="doc" href="${samplePath}/README.html">Documentation</a>
          <a class="run" href="${runUrl}">&#9654; Run in simulator</a>
        </div>
      </article>`
  })
  .join('\n')

writeFileSync(
  path.join(OUT, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Sample documentation — Zephyr in the Browser</title>
<link rel="icon" href="_static/favicon.png"/>
<style>
  :root { color-scheme: light dark; --accent: #7929d2; }
  body { font: 16px/1.55 system-ui, sans-serif; margin: 0 auto; max-width: 880px;
         padding: 2rem 1.25rem 4rem; }
  header a { color: var(--accent); text-decoration: none; }
  h1 { margin: .25rem 0 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
           gap: 1rem; margin-top: 1.5rem; padding: 0; }
  .card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
          border-radius: 10px; padding: 1rem 1.15rem; display: flex;
          flex-direction: column; gap: .5rem; }
  .card h2 { font-size: 1.1rem; margin: 0; }
  .card h2 a { color: inherit; text-decoration: none; }
  .card h2 a:hover { color: var(--accent); }
  .card p { margin: 0; opacity: .8; flex: 1; }
  .chip { font: 600 11px/1 system-ui; padding: 4px 8px; border-radius: 999px;
          background: color-mix(in srgb, var(--accent) 14%, transparent);
          color: color-mix(in srgb, var(--accent) 70%, currentColor); }
  .actions { display: flex; gap: .75rem; margin-top: .25rem; }
  .actions a { font-size: .9rem; text-decoration: none; }
  .actions .doc { color: inherit; opacity: .75; }
  .actions .doc:hover { opacity: 1; }
  .actions .run { color: #fff; background: var(--accent); padding: .35rem .7rem;
                  border-radius: 6px; }
  .actions .run:hover { filter: brightness(1.15); }
  footer { margin-top: 3rem; font-size: .85rem; opacity: .65; }
  footer a { color: inherit; }
</style>
</head>
<body>
<header>
  <a href="../">&#8592; Zephyr in the Browser</a>
  <h1>Sample documentation</h1>
  <p>Official Zephyr docs for every sample packaged with the emulator —
     each page has a <strong>Run in simulator</strong> button.</p>
</header>
<main class="cards">
${cards}
</main>
<footer>
  Pages mirrored from <a href="${DOCS_BASE}">docs.zephyrproject.org</a> on ${MIRROR_DATE}
  by <code>tools/fetch-docs.mjs</code>. Documentation &#169; Zephyr Project members and
  individual contributors, <a href="https://github.com/zephyrproject-rtos/zephyr/blob/main/LICENSE">Apache-2.0</a>.
</footer>
</body>
</html>
`,
)

console.log(`Wrote ${path.relative(repoRoot, OUT)}/ (index + ${samples.size} pages).`)
