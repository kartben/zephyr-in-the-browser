/**
 * The tour file format: Markdown an author would have written anyway, with the
 * stage directions in fenced ```tour blocks.
 *
 * A tour is CodeTour's model — an ordered list of steps, each anchored to a
 * place in the source — written the way a walkthrough wants to be written. The
 * whole point is that `tours/blinky.tour.md` is a readable article about blinky
 * when you open it in an editor or on GitHub, and a script the page can execute
 * only incidentally. Nothing about it is generated, and nothing about it is
 * compiled into the guest.
 *
 * ```markdown
 * ---
 * tour: Blinky, explained
 * sample: samples/basic/blinky
 * ---
 *
 * ## The pin is named by devicetree, not by this file
 *
 * ```tour
 * at: main.c:/gpio_pin_toggle_dt/
 * panel: gpio
 * watch:
 *   - pin = led+1p as u8
 * ```
 *
 * Nothing in this file says which pin the LED is on…
 * ```
 *
 * The directive block is a strict subset of YAML — plain `key: value` scalars,
 * `- item` lists and one level of nested mapping. Anything this parser accepts,
 * a real YAML parser accepts and reads the same way, which is why the block is
 * worth fencing as its own language rather than inventing punctuation. The one
 * exception is a ` #` inside a `/pattern/`, which stays in the pattern where
 * YAML would start a comment (see `maskPatterns`).
 *
 * Authoring mistakes are collected rather than thrown: a tour with one bad
 * anchor should still run its other nine steps, and the ones it dropped are
 * reported (see `problems`) instead of vanishing.
 */

import { PANEL_KINDS, type PanelKind } from '@/boards'
import { OBJECT_TYPES, objectTypeCode } from '@/debug/kernel/objectCores'
import type { DebugSection } from '@/lib/debugUi'
import { TRACE_TABS, traceTabFromTourName, traceTabTourName, type TraceTab } from '@/lib/traceTabs'
import { FORMATS, isKnownFormat } from '@/tours/expr'
import { isRunnableShell, parseMarkdown } from '@/tours/markdown'
import { isCommandLine, parsePlaceholders } from '@/tours/snippets'
import { isShippableSource } from '@/tours/sources'

/** One row of a step's `watch:` list — `label = expression as format`. */
export interface WatchSpec {
  /** Author's name for the value, or null to show the expression itself. */
  label: string | null
  /** Address expression; see tours/expr.ts. */
  expr: string
  /** Read format (`u32`, `string`, `code`, `bytes:8`, …). */
  format: string
}

/**
 * One `highlight:` entry: a line, a range of lines, or a pattern to find.
 *
 *     highlight: 21          one line
 *     highlight: 21-24       a range, inclusive
 *     highlight: /GPIO_DT_SPEC_GET/     the first line matching
 *     highlight: /^int main/ + 3        the match and the three lines after
 *
 * Line numbers are in the source as shipped; a pattern is resolved against the
 * same text an `at:` pattern searches, so it survives the file being edited
 * upstream in the same way.
 */
export type HighlightSpec =
  | { kind: 'lines'; start: number; end: number }
  | { kind: 'pattern'; pattern: string; extra: number }

/** A step's `memory:` block — which window of guest memory to put on screen. */
export interface MemorySpec {
  /** Address expression for the first byte shown. */
  at: string
  /** Bytes to show. */
  len: number
  /**
   * Offsets from `at` to highlight, end-exclusive, as expressions — `1p..2p`
   * marks the second pointer-sized field whatever the guest's word size.
   */
  mark: { start: string; end: string } | null
  /** Caption for the highlight. */
  note: string | null
}

/**
 * A step's `objects:` block — which live kernel objects to put on the card.
 *
 * Zephyr's `CONFIG_OBJ_CORE` links every mutex, semaphore, message queue and
 * thread onto a per-type list the debugger can walk, so "show me the six forks
 * and who holds them" needs no expression and no struct offsets: the object
 * cores already say what exists and the DWARF already says how to read it.
 */
export interface ObjectsSpec {
  /** Object-core type codes to show. Empty means every type the guest has. */
  types: string[]
  /** Address expression for the one object this step is about. */
  focus: string | null
  /**
   * `ring` draws the focused message queue as its ring buffer: every slot, the
   * messages in read order, and where the read and write pointers sit. Absent
   * for the plain rows.
   */
  view?: 'ring'
}

/**
 * One `look:` target: a view to put in front of the reader when the step fires.
 *
 *     look: trace.queues          a Trace tab
 *     look: debug.objects         a Debug section
 *     look: dock.gpio             a device dock row, the same as `panel: gpio`
 *
 * `panel:` can only name a row. A step about a queue filling up wants the
 * Queues tab inside Trace, and a reader left on the Timeline would not know
 * that is where to look.
 */
export type LookSpec =
  | { kind: 'trace'; tab: TraceTab }
  | { kind: 'debug'; section: DebugSection }
  | { kind: 'dock'; panel: PanelKind }

export interface TourStep {
  /** 0-based position, which is also the order the author wrote them in. */
  index: number
  title: string
  /** Markdown body; see src/components/Markdown.tsx for the subset rendered. */
  body: string
  /** Raw anchor — `file.c:/pattern/`, `file.c:12`, `symbol`, `symbol+0x10` or `0x40001234`. */
  at: string
  /** Hit condition, DAP's `hitCondition` spelt out: `hits == 1`, `hits % 4 == 0`. */
  when: string | null
  /** Stop the machine on this step. `stop: no` shows the card and runs on. */
  stop: boolean
  /** Keep the breakpoint after the step has fired. */
  repeat: boolean
  /** A PanelKind for the device dock to reveal. */
  panel: PanelKind | null
  /** Instrument views to open as the step fires, in the order written. */
  look: LookSpec[]
  /**
   * Source to light up in the excerpt, independent of where the breakpoint is.
   *
   * A step usually stops on one line and is *about* several — a declaration and
   * its use, a whole `if`, the three lines of a loop body. `at:` answers "where
   * does the machine stop"; this answers "what am I pointing at", and they are
   * not the same question.
   */
  highlight: HighlightSpec[]
  /**
   * Same as `highlight:`, but against the running guest's **devicetree**
   * (`blinky.dts`), not the file `at:` stopped in. A 101 step can pause on
   * `gpio_pin_configure_dt()` and point at the `led0` node that named the pin.
   */
  dts: HighlightSpec[]
  watch: WatchSpec[]
  memory: MemorySpec | null
  objects: ObjectsSpec | null
  /** Register names to spotlight, as the arch spells them. */
  registers: string[]
  /** Show the kernel thread list at this stop. */
  threads: boolean
  /**
   * The reader's part, when reaching this step is up to them: press a button,
   * type a command. One line of Markdown, shown on a "Your turn" card while the
   * guest runs on towards the step.
   */
  await: string | null
  /** Shell lines for the reader to type, shown on that same card. */
  do: string[]
}

/** How a tour ends: a last `##` section with no ```tour block under it. */
export interface TourOutro {
  title: string
  /** Markdown, rendered like a step body. */
  body: string
}

export interface TourDoc {
  /** Title from the front matter. */
  title: string
  /** Zephyr sample path this tour is written against, for cross-checking. */
  sample: string
  /** Prose between the front matter and the first step. */
  intro: string
  /**
   * When false (`source: no` in front matter), the card skips file/line crumbs
   * and source / devicetree snippets. Breakpoints from `at:` still plant; only
   * the teaching surface is prose + dock/terminal focus. Default true.
   */
  showSource: boolean
  /**
   * Files outside the sample whose code a stop may land in, as paths in the
   * Zephyr tree (`kernel/msg_q.c`). The image build ships a verbatim copy of
   * each beside the sample's own sources; see src/tours/sources.ts.
   */
  sources: string[]
  steps: TourStep[]
  /** Shown once every step has had its turn, with a way on to `next`. */
  outro: TourOutro | null
  /** Tour to offer after this one (`next:` in front matter), by tour id. */
  next: string | null
  /** Authoring errors, in file order. Rendered in dev, ignored in production. */
  problems: string[]
}

/* ------------------------------------------------------------------ *
 * The YAML subset
 * ------------------------------------------------------------------ */

type Directive = string | string[] | Record<string, string>

/**
 * Parse a directive block into scalars, lists and one-level mappings.
 *
 * Deliberately unforgiving about indentation: two spaces under a key, no tabs,
 * no flow syntax. The block is four lines long in practice, and a parser that
 * guesses at malformed input is worse than one that says so.
 */
export function parseDirectives(text: string): {
  values: Map<string, Directive>
  problems: string[]
} {
  const values = new Map<string, Directive>()
  const problems: string[] = []
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) {
      problems.push(`stray indented line: ${line.trim()}`)
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) {
      problems.push(`not a \`key: value\` line: ${line.trim()}`)
      continue
    }
    const key = line.slice(0, colon).trim()
    const inline = line.slice(colon + 1).trim()

    // Gather the indented block that belongs to this key, if any.
    const block: string[] = []
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
      block.push(lines[++i]!.trim())
    }

    if (block.length === 0) {
      values.set(key, stripComment(inline))
      continue
    }
    if (inline !== '') {
      problems.push(`\`${key}\` has both a value and an indented block`)
      continue
    }
    if (block.every((b) => b.startsWith('- '))) {
      values.set(
        key,
        block.map((b) => stripComment(b.slice(2).trim())),
      )
      continue
    }
    const map: Record<string, string> = {}
    for (const entry of block) {
      const eq = entry.indexOf(':')
      if (eq <= 0) {
        problems.push(`\`${key}\`: not a \`key: value\` line: ${entry}`)
        continue
      }
      map[entry.slice(0, eq).trim()] = stripComment(entry.slice(eq + 1).trim())
    }
    values.set(key, map)
  }

  return { values, problems }
}

/**
 * Drop a trailing `# comment`.
 *
 * Only outside quotes, only when the `#` is preceded by whitespace, and never
 * inside a `/pattern/`, so `mark: 0..4 # the port pointer` loses its note while
 * `at: main.c:12#2` and `at: main.c:/"tick #%u/` keep every character.
 */
function stripComment(value: string): string {
  const quoted = /^(["']).*\1$/.test(value)
  if (quoted) return value.slice(1, -1)
  const cut = maskPatterns(value).search(/\s#/)
  return (cut >= 0 ? value.slice(0, cut) : value).trim()
}

/**
 * The value with the inside of every `/pattern/` blanked out, at the same length.
 *
 * `#` and `,` mean something to the directive syntax (a comment, the next list
 * entry) and something else inside a regular expression, where both turn up in
 * exactly the lines worth pointing at: a `printk("tick #%u")`, a call with two
 * arguments. Searching the masked copy and slicing the original by the same
 * index is how the syntax gets to look past them.
 *
 * A pattern opens with a `/` at the start of the value or after a space, `:`,
 * `,` or `|`, which covers every place the vocabulary puts one (`main.c:/x/`,
 * `highlight: /x/`, `21, /x/`). A `/` that never closes is only a slash, so
 * `sample: samples/basic/blinky` and the prose in a `note:` read as before.
 */
function maskPatterns(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const opens = value[i] === '/' && (i === 0 || /[\s:,|]/.test(value[i - 1]!))
    const end = opens ? patternEnd(value, i) : -1
    if (end < 0) {
      out += value[i]
      continue
    }
    out += `/${'_'.repeat(end - i - 1)}/`
    i = end
  }
  return out
}

/**
 * Where the `/pattern/` opened at `open` closes, or -1 when it does not.
 *
 * A pattern may hold a `/` of its own, escaped or not (`/a \/ b/`, `/a / b/`),
 * so the closer is the first unescaped `/` that ends the value or is followed
 * by what can follow a pattern: `|` (the next `at:` alternative), `,` (the next
 * list entry), `+` (a highlight's extra lines) or ` #` (a comment).
 */
function patternEnd(value: string, open: number): number {
  for (let i = open + 1; i < value.length; i++) {
    if (value[i] === '\\') {
      i++
      continue
    }
    if (value[i] === '/' && /^(?:\s*(?:[|,+]|$)|\s+#)/.test(value.slice(i + 1))) return i
  }
  return -1
}

function asScalar(value: Directive | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asBool(value: Directive | undefined, fallback: boolean): boolean {
  const raw = asScalar(value)?.toLowerCase()
  if (raw === undefined || raw === null) return fallback
  if (['yes', 'true', 'on', '1'].includes(raw)) return true
  if (['no', 'false', 'off', '0'].includes(raw)) return false
  return fallback
}

/* ------------------------------------------------------------------ *
 * Directive keys
 * ------------------------------------------------------------------ */

/**
 * The keys a step's directive block may use that do something.
 *
 * A key outside this list and RESERVED_KEYS is reported, because the parser
 * only reads the keys it knows: `wacth:` would cost the card its values and
 * nothing would say why.
 */
export const IMPLEMENTED_KEYS = [
  'at',
  'when',
  'stop',
  'repeat',
  'panel',
  'reveal',
  'look',
  'highlight',
  'dts',
  'watch',
  'memory',
  'objects',
  'registers',
  'threads',
  'await',
  'do',
] as const

/**
 * Keys a planned directive will use. They are accepted and ignored until it
 * lands, so a tour written against it already parses; the change that
 * implements one moves it to IMPLEMENTED_KEYS.
 */
export const RESERVED_KEYS = ['check', 'pass', 'fail', 'retry'] as const

const KNOWN_KEYS: ReadonlySet<string> = new Set([...IMPLEMENTED_KEYS, ...RESERVED_KEYS])

/** The keys in a directive block that neither list has, in the order written. */
export function unknownKeys(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => !KNOWN_KEYS.has(key))
}

/* ------------------------------------------------------------------ *
 * Directive vocabulary
 * ------------------------------------------------------------------ */

/**
 * Parse one `watch:` row — `[label =] expression [as format]`.
 *
 * The format defaults to `u32` because that is what an unadorned word in a
 * 32-bit guest is, and naming it every time would bury the expression.
 */
export function parseWatch(raw: string): WatchSpec | null {
  let rest = raw.trim()
  if (rest === '') return null

  let label: string | null = null
  // Split on the first `=` that is not part of `==`, `>=`, `<=` or `!=`.
  const eq = rest.search(/(?<![=!<>])=(?!=)/)
  if (eq > 0) {
    label = rest.slice(0, eq).trim()
    rest = rest.slice(eq + 1).trim()
  }

  let format = 'u32'
  const as = rest.match(/\s+as\s+([A-Za-z][A-Za-z0-9:_]*)$/)
  if (as) {
    format = as[1]!.toLowerCase()
    rest = rest.slice(0, as.index).trim()
  }
  if (rest === '') return null
  return { label, expr: rest, format }
}

/**
 * Parse `mark: 4..8` — offsets from the window start, end-exclusive.
 *
 * Both sides are expressions (src/tours/expr.ts) rather than plain numbers, so
 * `1p..2p` says "the second pointer-sized field" and means eight bytes on
 * AArch64 and four on Cortex-M. They are evaluated when the step fires, since
 * only then is the guest's word size known.
 */
function parseMark(raw: string | undefined): { start: string; end: string } | null {
  if (!raw) return null
  const at = raw.indexOf('..')
  if (at <= 0) return null
  const start = raw.slice(0, at).trim()
  const end = raw.slice(at + 2).trim()
  if (start === '' || end === '') return null
  return { start, end }
}

const DEFAULT_MEMORY_BYTES = 64

function parseMemory(value: Directive | undefined, problems: string[]): MemorySpec | null {
  if (value === undefined) return null
  // `memory: led` is the short form of a block with only `at:`.
  const map = typeof value === 'string' ? { at: value } : value
  if (Array.isArray(map)) {
    problems.push('`memory:` takes a block, not a list')
    return null
  }
  const at = map.at?.trim()
  if (!at) {
    problems.push('`memory:` needs an `at:` address')
    return null
  }
  const len = map.len ? Number(map.len) : DEFAULT_MEMORY_BYTES
  if (!Number.isFinite(len) || len <= 0 || len > 1024) {
    problems.push(`\`memory: len: ${map.len}\` is not a byte count between 1 and 1024`)
    return null
  }
  if (map.mark && !parseMark(map.mark)) {
    problems.push(`\`memory: mark: ${map.mark}\` is not a \`start..end\` byte range`)
  }
  return {
    at,
    len,
    mark: parseMark(map.mark),
    note: map.note?.trim() || null,
  }
}

/**
 * Parse `objects:` — the live kernel objects to show.
 *
 *     objects: mutex               one type
 *     objects: sem, mutex          several
 *     objects: all                 everything this guest registered
 *     objects:                     …and which one the step is about
 *       type: mutex
 *       focus: $arg0
 *     objects:                     one message queue, drawn as its ring
 *       type: msgq
 *       focus: my_msgq
 *       view: ring
 *
 * Type names are the ones a person would write (`mutex`, `semaphores`), not the
 * four-letter codes the kernel stamps into each `k_obj_type`, though those work
 * too. An unknown name is an authoring mistake worth failing the test over: it
 * would otherwise render as an empty list, which reads exactly like a guest
 * with no objects of that type.
 */
function parseObjects(value: Directive | undefined, problems: string[]): ObjectsSpec | null {
  if (value === undefined) return null
  const map =
    typeof value === 'string' || Array.isArray(value) ? { type: parseList(value).join(',') } : value
  const written = parseList(map.types ?? map.type ?? '')
  const types: string[] = []
  for (const name of written) {
    if (['all', 'yes', 'true', 'on'].includes(name.toLowerCase())) continue
    const code = objectTypeCode(name)
    if (code === null) {
      problems.push(`\`objects: ${name}\` is not a kernel object type (${OBJECT_TYPES.join(', ')})`)
      continue
    }
    if (!types.includes(code)) types.push(code)
  }
  const focus = map.focus?.trim() || null
  const view = parseObjectsView(map.view, types, focus, problems)
  return { types, focus, ...(view ? { view } : {}) }
}

/**
 * `view:` under `objects:`. `ring` draws the focused message queue as its ring
 * buffer, and a step about one queue gets it without asking: the slots, and
 * where the read and write pointers sit on them, are what a queue *is*, and
 * three numbers in a row do not show that. `view: list` keeps the plain row.
 *
 * Only a step about one queue can have a ring, and that has to be decidable
 * here, before anything has been read: hence `type: msgq` and a `focus:`.
 */
function parseObjectsView(
  raw: string | undefined,
  types: string[],
  focus: string | null,
  problems: string[],
): 'ring' | null {
  const oneQueue = focus !== null && types.length === 1 && types[0] === 'MSGQ'
  const view = raw?.trim().toLowerCase()
  if (!view) return oneQueue ? 'ring' : null
  if (view === 'list') return null
  if (view !== 'ring') {
    problems.push(`\`objects: view: ${raw!.trim()}\` is not a view (list, ring)`)
    return null
  }
  if (!oneQueue) {
    problems.push('`objects: view: ring` draws one message queue: it needs `type: msgq` and a `focus:`')
    return null
  }
  return 'ring'
}

function isPanelKind(name: string): name is PanelKind {
  return (PANEL_KINDS as readonly string[]).includes(name)
}

/**
 * Parse `panel:`, or `reveal:`, its older spelling.
 *
 * A kind the dock does not know is reported rather than passed on: it would
 * reveal nothing, which reads exactly like a board without that peripheral.
 */
function parsePanel(
  values: Map<string, Directive>,
  where: string,
  problems: string[],
): PanelKind | null {
  for (const key of ['panel', 'reveal']) {
    const raw = asScalar(values.get(key))
    if (raw === null) continue
    if (isPanelKind(raw)) return raw
    problems.push(`${where}: \`${key}: ${raw}\` is not a panel (${PANEL_KINDS.join(', ')})`)
    return null
  }
  return null
}

/**
 * Debug sections a tour can open. A record rather than a list, so a section
 * added to DebugSection cannot be left out here.
 */
const DEBUG_SECTIONS: Record<DebugSection, true> = {
  breakpoints: true,
  cpu: true,
  stack: true,
  memory: true,
  threads: true,
  objects: true,
}

/** Every `look:` spelling, for the problem a bad one reports. */
const LOOK_TARGETS = [
  ...TRACE_TABS.map((tab) => `trace.${traceTabTourName(tab)}`),
  ...Object.keys(DEBUG_SECTIONS).map((section) => `debug.${section}`),
  'dock.<panel>',
].join(', ')

/** Parse one `look:` target. Returns null for anything that names no view. */
export function parseLook(raw: string): LookSpec | null {
  const dot = raw.indexOf('.')
  if (dot <= 0) return null
  const name = raw.slice(dot + 1)
  switch (raw.slice(0, dot)) {
    case 'trace': {
      const tab = traceTabFromTourName(name)
      return tab ? { kind: 'trace', tab } : null
    }
    case 'debug':
      return Object.hasOwn(DEBUG_SECTIONS, name)
        ? { kind: 'debug', section: name as DebugSection }
        : null
    case 'dock':
      return isPanelKind(name) ? { kind: 'dock', panel: name } : null
    default:
      return null
  }
}

/**
 * Parse `look:`, one target or a list.
 *
 *     look: trace.queues
 *     look:
 *       - trace.timeline
 *       - debug.objects
 *
 * A target that names no view is reported: the step would otherwise fire and
 * open nothing, and the prose would be pointing at a view that never appears.
 */
function parseLooks(value: Directive | undefined, where: string, problems: string[]): LookSpec[] {
  if (value !== undefined && typeof value !== 'string' && !Array.isArray(value)) {
    problems.push(`${where}: \`look:\` takes a target or a list of them, not a block`)
    return []
  }
  const looks: LookSpec[] = []
  for (const raw of parseList(value)) {
    const look = parseLook(raw)
    if (look) looks.push(look)
    else problems.push(`${where}: \`look: ${raw}\` is not a view (${LOOK_TARGETS})`)
  }
  return looks
}

const HIGHLIGHT_RANGE = /^(\d+)\s*(?:-\s*(\d+))?$/
const HIGHLIGHT_PATTERN = /^\/(.+)\/(?:\s*\+\s*(\d+))?$/

/**
 * Turn `highlight:` / `dts:` specs into line ranges against a source file.
 *
 * Patterns that match nothing are dropped rather than guessed at: a highlight
 * over the wrong lines is worse than none.
 */
export function resolveHighlightSpecs(
  specs: HighlightSpec[],
  lines: string[] | undefined,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const spec of specs) {
    if (spec.kind === 'lines') {
      out.push({ start: spec.start, end: spec.end })
      continue
    }
    if (!lines) continue
    let re: RegExp
    try {
      re = new RegExp(spec.pattern)
    } catch {
      continue
    }
    const hit = lines.findIndex((line) => re.test(line))
    if (hit < 0) continue
    out.push({ start: hit + 1, end: hit + 1 + spec.extra })
  }
  return out
}

/** Parse one `highlight:` entry. Returns null for anything unrecognised. */
export function parseHighlight(raw: string): HighlightSpec | null {
  const text = raw.trim()
  const range = HIGHLIGHT_RANGE.exec(text)
  if (range) {
    const start = Number(range[1])
    const end = range[2] === undefined ? start : Number(range[2])
    if (start < 1 || end < start) return null
    return { kind: 'lines', start, end }
  }
  const pattern = HIGHLIGHT_PATTERN.exec(text)
  if (pattern) {
    return { kind: 'pattern', pattern: pattern[1]!, extra: Number(pattern[2] ?? 0) }
  }
  return null
}

function parseHighlightList(
  value: Directive | undefined,
  where: string,
  key: string,
  problems: string[],
): HighlightSpec[] {
  const out: HighlightSpec[] = []
  for (const row of parseList(value)) {
    const spec = parseHighlight(row)
    if (spec) out.push(spec)
    else problems.push(`${where}: \`${key}: ${row}\` is not a line, a range or a /pattern/`)
  }
  return out
}

function parseList(value: Directive | undefined): string[] {
  if (value === undefined) return []
  if (Array.isArray(value)) return value.filter((v) => v !== '')
  if (typeof value === 'string') {
    // Split on the commas between entries, not the ones inside a `/pattern/`:
    // the masked copy has the same length, so its pieces map straight back.
    let at = 0
    return maskPatterns(value)
      .split(',')
      .map((masked) => {
        const entry = value.slice(at, at + masked.length)
        at += masked.length + 1
        return entry.trim()
      })
      .filter((v) => v !== '')
  }
  return []
}

/**
 * Parse `do:`, the shell lines a your-turn card offers, in order.
 *
 * A scalar is one line rather than a comma-separated list as elsewhere: in a
 * shell command a comma is ordinary text.
 */
function parseDo(value: Directive | undefined, where: string, problems: string[]): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (Array.isArray(value)) return value.filter((line) => line !== '')
  problems.push(`${where}: \`do:\` takes shell lines, not a block of \`key: value\``)
  return []
}

function buildStep(
  index: number,
  title: string,
  directives: string,
  body: string,
  problems: string[],
): TourStep | null {
  const where = `step ${index + 1} (“${title}”)`
  const parsed = parseDirectives(directives)
  for (const problem of parsed.problems) problems.push(`${where}: ${problem}`)
  for (const key of unknownKeys(parsed.values.keys())) {
    problems.push(`${where}: \`${key}:\` is not a directive`)
  }

  const at = asScalar(parsed.values.get('at'))
  if (!at) {
    problems.push(`${where}: no \`at:\` — a step has to say where it breaks`)
    return null
  }

  const watch: WatchSpec[] = []
  for (const row of parseList(parsed.values.get('watch'))) {
    const spec = parseWatch(row)
    if (!spec) {
      problems.push(`${where}: \`watch: ${row}\` has no expression`)
      continue
    }
    if (!isKnownFormat(spec.format)) {
      problems.push(`${where}: \`as ${spec.format}\` is not a format (${FORMATS.join(', ')})`)
      continue
    }
    watch.push(spec)
  }

  const memory = parseMemory(parsed.values.get('memory'), problems)

  const objectProblems: string[] = []
  const objects = parseObjects(parsed.values.get('objects'), objectProblems)
  for (const problem of objectProblems) problems.push(`${where}: ${problem}`)

  const panel = parsePanel(parsed.values, where, problems)
  const look = parseLooks(parsed.values.get('look'), where, problems)

  const highlight = parseHighlightList(parsed.values.get('highlight'), where, 'highlight', problems)
  const dts = parseHighlightList(parsed.values.get('dts'), where, 'dts', problems)

  const stop = asBool(parsed.values.get('stop'), true)
  const threads = asBool(parsed.values.get('threads'), false)
  /*
   * `watch:` and `memory:` are read while the machine is still stopped, so they
   * survive `stop: no`. The thread and object walks do not: they are dozens of
   * RSP round-trips that the debugger starts a beat after the registers land,
   * and a `stop: no` step has let the guest go before they finish. What is left
   * on the card is a spinner that never resolves.
   */
  const walkable = stop || !(threads || objects)
  if (!walkable) {
    problems.push(
      `${where}: \`stop: no\` cannot show \`${threads ? 'threads' : 'objects'}:\` — ` +
        'the machine runs on before the walk finishes',
    )
  }

  // `do:` lines are only ever shown on the your-turn card, which `await:` puts up.
  const awaitText = asScalar(parsed.values.get('await'))
  const doLines = parseDo(parsed.values.get('do'), where, problems)
  if (doLines.length > 0 && awaitText === null) {
    problems.push(`${where}: \`do:\` needs an \`await:\` to say what the lines are for`)
  }

  return {
    index,
    title,
    body: body.trim(),
    at,
    when: asScalar(parsed.values.get('when')),
    stop,
    repeat: asBool(parsed.values.get('repeat'), false),
    panel,
    look,
    highlight,
    dts,
    watch,
    memory,
    // Dropped rather than rendered as a spinner nothing will ever resolve.
    objects: walkable ? objects : null,
    registers: parseList(parsed.values.get('registers')),
    threads: walkable && threads,
    await: awaitText,
    do: doLines,
  }
}

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

const FENCE = /^(```|~~~)\s*(\S*)\s*$/

/**
 * Check the runnable ```shell blocks in some prose.
 *
 * Their placeholders are filled in on the card, from the running guest. One
 * that could never fill (a misspelt kind, a missing brace) is caught here, as
 * a failing tour test, rather than as a Run button that never enables.
 */
function snippetProblems(where: string, markdown: string): string[] {
  const problems: string[] = []
  for (const block of parseMarkdown(markdown)) {
    if (block.kind !== 'codeblock' || !isRunnableShell(block.language)) continue
    if (!block.text.split('\n').some(isCommandLine)) {
      problems.push(`${where}: a \`shell\` block has no command to run`)
    }
    for (const problem of parsePlaceholders(block.text).problems) {
      problems.push(`${where}: ${problem}`)
    }
  }
  return problems
}

/**
 * Parse a `.tour.md` document.
 *
 * Never throws. A file that is not a tour at all — the dev server answering an
 * unknown path with index.html, say — comes back with no steps, which every
 * caller already treats as "this sample has no tour".
 */
export function parseTour(text: string): TourDoc {
  const problems: string[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let at = 0

  // Front matter, Jekyll-style. Optional, but a tour without a title is
  // anonymous in the gallery, so say so.
  const front = new Map<string, Directive>()
  if (lines[0]?.trim() === '---') {
    let end = 1
    while (end < lines.length && lines[end]!.trim() !== '---') end++
    const parsed = parseDirectives(lines.slice(1, end).join('\n'))
    for (const [k, v] of parsed.values) front.set(k, v)
    for (const problem of parsed.problems) problems.push(`front matter: ${problem}`)
    at = Math.min(end + 1, lines.length)
  }

  const intro: string[] = []
  /*
   * Every `##` section is collected before any is built. A section with no
   * ```tour block is the outro when it comes last and a mistake anywhere else,
   * and which one it is is only known at the end of the file.
   */
  const sections: Array<{ title: string; directives: string[] | null; body: string[] }> = []
  let section: (typeof sections)[number] | null = null
  let fence: string | null = null
  let inTourBlock = false

  for (; at < lines.length; at++) {
    const line = lines[at]!
    const fenced = FENCE.exec(line)
    const prose = section ? section.body : intro

    if (fence !== null) {
      // Inside a fence: only its matching closer means anything.
      if (fenced && fenced[1] === fence) {
        if (inTourBlock) inTourBlock = false
        else prose.push(line)
        fence = null
      } else if (inTourBlock) {
        section!.directives!.push(line)
      } else {
        prose.push(line)
      }
      continue
    }

    if (fenced) {
      fence = fenced[1]!
      // The stage directions, but only before the step's prose starts — a
      // ```tour block further down is a tour talking about tours.
      inTourBlock =
        fenced[2] === 'tour' &&
        section !== null &&
        section.directives === null &&
        section.body.join('').trim() === ''
      if (inTourBlock) section!.directives = []
      else prose.push(line)
      continue
    }

    const heading = /^##\s+(.*\S)\s*$/.exec(line)
    if (heading) {
      section = { title: heading[1]!, directives: null, body: [] }
      sections.push(section)
      continue
    }
    prose.push(line)
  }

  const last = sections[sections.length - 1]
  const outro = last && last.directives === null ? sections.pop()! : null
  const steps: TourStep[] = []
  for (const { title, directives, body } of sections) {
    const step = buildStep(steps.length, title, (directives ?? []).join('\n'), body.join('\n'), problems)
    if (step) {
      steps.push(step)
      const where = `step ${step.index + 1} (“${step.title}”)`
      problems.push(...snippetProblems(where, step.body))
      // `do:` lines render as the same runnable snippet on the your-turn card.
      for (const problem of parsePlaceholders(step.do.join('\n')).problems) {
        problems.push(`${where}: \`do:\` ${problem}`)
      }
    }
  }

  if (fence !== null) problems.push('unclosed code fence')

  // A tour id is an app id today; once a sample can host several tours it
  // gains a `.slug`, so a dot is allowed. A path or a title is not.
  let next = asScalar(front.get('next'))
  if (next !== null && !/^[\w][\w.-]*$/.test(next)) {
    problems.push(`front matter: \`next: ${next}\` is not a tour id (an app id, like \`basic_button\`)`)
    next = null
  }
  if (next !== null && outro === null) {
    problems.push('front matter: `next:` needs an outro, a last `##` section with no ```tour block')
  }

  // The build copies each of these out of the Zephyr tree, so one that would
  // reach outside it is refused here as well as there.
  const sources: string[] = []
  for (const path of parseList(front.get('sources'))) {
    if (isShippableSource(path)) {
      sources.push(path)
      continue
    }
    problems.push(
      `front matter: \`sources: ${path}\` is not a path inside the Zephyr tree, like \`kernel/msg_q.c\``,
    )
  }

  return {
    title: asScalar(front.get('tour')) ?? asScalar(front.get('title')) ?? 'Guided tour',
    sample: asScalar(front.get('sample')) ?? '',
    intro: intro.join('\n').trim(),
    // `source: no` hides guest source / DTS excerpts on the card (tool tours).
    showSource: asBool(front.get('source'), true),
    sources,
    steps,
    outro: outro && { title: outro.title, body: outro.body.join('\n').trim() },
    next,
    problems,
  }
}
