/**
 * The source files an image ships beside a toured sample, and how a stop finds
 * its own among them.
 *
 * The image build copies the sample's `src/*.c` and `src/*.h` verbatim, plus
 * every file the tour's front matter lists under `sources:`, and writes an
 * index naming them all:
 *
 *     src/msg_queue/main.c                   the sample's own
 *     src/msg_queue/zephyr/kernel/msg_q.c    sources: [kernel/msg_q.c]
 *     src/msg_queue/index.json               {"files": ["main.c", "zephyr/kernel/msg_q.c"]}
 *
 * A stop knows its file only as the path the compiler recorded in DWARF, on
 * whatever machine built the image: `/workdir/zephyr/kernel/msg_q.c` in the
 * container, `/home/runner/work/…/zephyr/kernel/msg_q.c` in CI, somebody's
 * home directory on a laptop. None of those prefixes mean anything here, so
 * the shipped file is the one that shares the longest tail with it.
 *
 * No imports, on purpose: the dev server (vite.config.ts) serves the same
 * layout out of a local Zephyr workspace and takes these rules from here.
 */

/** What an image shipped for a toured sample, from `src/<app>/index.json`. */
export interface SourceIndex {
  /** Paths under `src/<app>/`, as shipped: `main.c`, `zephyr/kernel/msg_q.c`. */
  files: string[]
}

/** Where the Zephyr tree's files land under `src/<app>/`. */
const ZEPHYR_DIR = 'zephyr'
/**
 * The prefix that names one of this repository's own files instead, the same
 * convention tools/samples.manifest uses for the samples under zephyr-module/.
 */
const MODULE_DIR = 'zephyr-module'

/**
 * A `sources:` entry the build can ship: relative, and inside the tree.
 *
 * The build joins it onto a directory and copies what is there, so an
 * absolute path or a `..` would copy something that is not Zephyr at all.
 */
export function isShippableSource(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** Where a `sources:` entry lands under `src/<app>/`. */
export function shippedPath(source: string): string {
  return source.startsWith(`${MODULE_DIR}/`) ? source : `${ZEPHYR_DIR}/${source}`
}

/**
 * `sources:` out of a tour's front matter, for the dev server, which cannot
 * load src/tours/parse.ts. Reads the same subset the same way: a `- path`
 * list under the key, or one comma-separated line. Unshippable entries are
 * dropped here; the parser is what reports them.
 */
export function frontMatterSources(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return []
  let end = 1
  while (end < lines.length && lines[end]!.trim() !== '---') end++

  let found: string[] = []
  for (let i = 1; i < end; i++) {
    const key = /^sources\s*:(.*)$/.exec(lines[i]!)
    if (!key) continue
    const block: string[] = []
    while (i + 1 < end && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
    if (block.length === 0) {
      found = scalar(key[1]!).split(',').map((v) => v.trim())
    } else if (key[1]!.trim() === '') {
      // A mapping rather than a list reads as no paths, as it does in parse.ts.
      found = block.every((b) => b.startsWith('- ')) ? block.map((b) => scalar(b.slice(2))) : []
    }
  }
  return found.filter(isShippableSource)
}

/** A YAML-subset scalar: quotes stripped, or a trailing ` # comment` cut. */
function scalar(raw: string): string {
  const value = raw.trim()
  if (/^(["']).*\1$/.test(value)) return value.slice(1, -1)
  const cut = value.search(/\s#/)
  return (cut >= 0 ? value.slice(0, cut) : value).trim()
}

/**
 * Read `index.json`. Null when it is not one, which reads the same as an
 * image built before there was an index.
 */
export function parseSourceIndex(raw: unknown): SourceIndex | null {
  if (typeof raw !== 'object' || raw === null) return null
  const files = (raw as { files?: unknown }).files
  if (!Array.isArray(files)) return null
  // Each entry ends up in a URL, so it gets the same check a `sources:` does.
  return { files: files.filter((f): f is string => typeof f === 'string' && isShippableSource(f)) }
}

/**
 * Path segments, lowercased (the line table's own matching ignores case too),
 * with `.` and empty segments dropped and `..` folded where it can be.
 */
function segments(path: string): string[] {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').toLowerCase().split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out
}

/** How many trailing segments two paths have in common. */
function sharedTail(a: string[], b: string[]): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

/**
 * The shipped file a stop's DWARF path refers to, or null when the image did
 * not ship it.
 *
 * A file is a candidate only when its whole path inside its own tree matches:
 * `zephyr/kernel/sched.c` must end the stop's path as `kernel/sched.c`, so it
 * never stands in for some other `sched.c`. That part leaves out the `zephyr/`
 * directory, because a Zephyr checkout is not always called that. Among the
 * candidates the longest shared tail wins, which is what lets a kernel file
 * and a sample file of the same name both ship. A tie means two files match
 * equally well, and showing either would be a guess.
 */
export function shippedPathFor(anchorFile: string, index: SourceIndex): string | null {
  const anchor = segments(anchorFile)
  let best: string | null = null
  let bestScore = 0
  let tied = false
  for (const file of index.files) {
    const shipped = segments(file)
    const [root] = shipped
    const own =
      shipped.length > 1 && (root === ZEPHYR_DIR || root === MODULE_DIR) ? shipped.slice(1) : shipped
    if (own.length === 0 || sharedTail(anchor, own) < own.length) continue
    const score = sharedTail(anchor, shipped)
    if (score > bestScore) {
      best = file
      bestScore = score
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  }
  return tied ? null : best
}

/**
 * The shipped file an `at: file.c:/pattern/` anchor names: by basename, or by
 * a longer tail (`kernel/msg_q.c`) where a basename is not enough. The
 * shortest match wins, so the sample's own `main.c` beats any deeper one.
 */
export function shippedFileNamed(name: string, index: SourceIndex): string | null {
  const want = segments(name)
  if (want.length === 0) return null
  let best: string | null = null
  let bestLength = Infinity
  for (const file of index.files) {
    const shipped = segments(file)
    if (sharedTail(shipped, want) < want.length || shipped.length >= bestLength) continue
    best = file
    bestLength = shipped.length
  }
  return best
}

/** Whose code a shipped file is, for the card to say so. */
export interface Provenance {
  /** `Zephyr kernel`, `Zephyr`, `this sample` or `this page's module`. */
  origin: string
  /** The file's path in that tree: `kernel/msg_q.c`, `main.c`. */
  path: string
}

/**
 * Name where a shipped file came from.
 *
 * A stop inside the kernel reads differently from one in the sample, and the
 * card should say which the reader is looking at before they read the code.
 */
export function provenance(shipped: string): Provenance {
  const [root, ...rest] = shipped.split('/')
  if (rest.length > 0 && root === ZEPHYR_DIR) {
    return { origin: rest[0] === 'kernel' ? 'Zephyr kernel' : 'Zephyr', path: rest.join('/') }
  }
  if (rest.length > 0 && root === MODULE_DIR) {
    return { origin: "this page's module", path: rest.join('/') }
  }
  return { origin: 'this sample', path: shipped }
}
