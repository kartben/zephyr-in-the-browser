/**
 * Running a tour.
 *
 * The engine is small because the debugger does the work: resolve each step's
 * `at:` to an address, plant a breakpoint, and when the machine stops there,
 * read whatever the step asked to show and put a card on screen. Continue
 * resumes. That is the whole loop.
 *
 * What it replaces is worth spelling out, because the difference is the point.
 * The old walkthrough lived *inside* the firmware: macros in the sample,
 * a generated table linked into the image, a Kconfig to turn it on, an
 * extractor in the app's CMakeLists, and records smuggled out over the console
 * as escape sequences that a stray `printk` could corrupt. A tour is a Markdown
 * file the browser reads. The guest is stock, un-rebuilt, and unaware.
 *
 * Module-level store plus subscribe/getSnapshot, read through
 * useSyncExternalStore — the same shape as dockStore, devicetree and hostNet.
 */

import { buildLineIndex, type LineIndex } from '@/debug/dwarfLines'
import { dwarfStructMembers } from '@/debug/dwarfMembers'
import { registerValues } from '@/debug/registerModel'
import { formatSymbol, resolveDataSymbol, resolveSymbol } from '@/debug/elfSymbols'
import type { MsgqRingSnapshot } from '@/debug/kernel/msgqRing'
import { readMsgqRing } from '@/debug/kernel/objectCores'
import * as debug from '@/debug/control'
import * as gdb from '@/hostGdb'
import { normalizeAddr, patternFile, resolveAnchor, type ResolvedAnchor } from '@/tours/anchors'
import { evalAddress, evalWatch, type TourTarget } from '@/tours/expr'
import { loadTourSource } from '@/tours/catalog'
import { focusStep, lookNotes } from '@/tours/look'
import { parseTour, resolveHighlightSpecs, type TourDoc, type TourStep } from '@/tours/parse'
import { evalPredicate } from '@/tours/predicate'
import {
  parseSourceIndex,
  provenance,
  shippedFileNamed,
  shippedPathFor,
  type Provenance,
  type SourceIndex,
} from '@/tours/sources'
import { whenFires } from '@/tours/when'

const ENABLED_KEY = 'zephyr-tours-enabled'

/** How long to wait for a gdb session before complaining that there is none. */
const ARM_GRACE_MS = 25_000

/** One evaluated `watch:` row. */
export interface TourValue {
  label: string
  expr: string
  format: string
  text: string
  detail: string | null
  ok: boolean
}

/** One `check:` row, evaluated when the step fired. */
export interface TourCheckRow {
  /** The comparison as written. */
  text: string
  /** It held, it did not, or (null) a side could not be read. */
  pass: boolean | null
  /** The sides that are not bare numbers, as the guest had them, or why it could not say. */
  values: Array<{ expr: string; text: string; ok: boolean }>
}

/** A step's `check:` rows and the verdict on them. */
export interface TourCheck {
  rows: TourCheckRow[]
  /**
   * `passed` when every row held, `failed` when one did not, and `unknown` when
   * none failed but one could not be read, which on the mock backend's replay
   * is every row. Only `passed` is a pass.
   */
  outcome: 'passed' | 'failed' | 'unknown'
  /** The step keeps its breakpoint and fires again: it retries and has not passed. */
  retrying: boolean
}

/** The window a step's `memory:` block asked for, once read. */
export interface TourMemory {
  addr: number | null
  bytes: Uint8Array | null
  len: number
  mark: { start: number; end: number } | null
  note: string | null
  error: string | null
}

/**
 * The live kernel objects a step's `objects:` block asked for.
 *
 * Only the question is stored. The answer is read from the debugger's
 * object-core walk as the card renders, the same way `threads:` is: the walk
 * runs a beat after the registers land, so a snapshot taken while building the
 * card would show the *previous* stop's objects.
 */
export interface TourObjects {
  /** Object-core type codes, or empty for every type. */
  types: string[]
  /** The one object this step is about, once its expression was evaluated. */
  focus: number | null
  /**
   * The focused message queue as a ring (`view: ring`), read while the machine
   * was stopped. The exception to "only the question is stored": see readRing.
   */
  ring: MsgqRingSnapshot | null
}

/** A run of source lines to light up, inclusive, in the anchor's file. */
export interface TourHighlight {
  start: number
  end: number
}

export interface TourCard {
  step: TourStep
  /** Where the breakpoint actually landed. */
  anchor: ResolvedAnchor | null
  /** The machine is stopped underneath this card. */
  paused: boolean
  /** Which time through this was. */
  hits: number
  values: TourValue[]
  /** The step's `check:` rows and the verdict on them, or null when it checks nothing. */
  check: TourCheck | null
  memory: TourMemory | null
  objects: TourObjects | null
  registers: Array<{ name: string; value: string }>
  threads: boolean
  /** Lines the step is *about*, which need not be the line it stopped on. */
  highlight: TourHighlight[]
  /** Why a view the step points at is not on screen, such as Trace on an untraced build. */
  lookNotes: string[]
  /**
   * The stop's file as the image shipped it, under `src/<app>/`: `main.c`, or
   * `zephyr/kernel/msg_q.c` for one the tour's `sources:` asked for. Null
   * when the image did not ship it, so there is no excerpt to show.
   */
  source: string | null
  /** Whose code that is, for the card's crumb. Null on an image with no index. */
  provenance: Provenance | null
}

/** What the reader is asked to do before the step the tour is waiting on. */
export interface TourWaiting {
  /** The step that fires once they have done it. */
  index: number
  /** The step's `await:`, one line of Markdown. */
  text: string
  /** The step's `do:` lines. */
  do: string[]
  /** Views the step points at that this guest cannot show; see TourCard.lookNotes. */
  notes: string[]
}

export interface TourState {
  doc: TourDoc | null
  /** The reader has not turned tours off. */
  enabled: boolean
  /** Breakpoints are planted; the tour is waiting for the guest to arrive. */
  armed: boolean
  /** A real gdb session is driving. False on the mock backend's replay. */
  live: boolean
  current: TourCard | null
  /**
   * No card is up, the guest is running, and the step it is running towards
   * has an `await:`: reaching it is the reader's job, so say what to do.
   */
  waiting: TourWaiting | null
  /** Step indexes already shown. */
  seen: Set<number>
  finished: boolean
  /**
   * The tour finished because every step had its turn, not because the reader
   * left it. The completion card is up while this holds; closing it clears it.
   */
  completed: boolean
  /**
   * Anchors that did not resolve, and authoring mistakes in the file. A tour
   * whose sixth step points at a line the optimiser folded away should still
   * run the other five and say what happened to the sixth.
   */
  problems: string[]
}

const EMPTY: TourState = {
  doc: null,
  enabled: true,
  armed: false,
  live: false,
  current: null,
  waiting: null,
  seen: new Set(),
  finished: false,
  completed: false,
  problems: [],
}

export interface StepRuntime {
  step: TourStep
  anchor: ResolvedAnchor | null
  /** The anchor did not resolve against this build; the step is skipped. */
  unresolved: boolean
  /** Breakpoint is currently planted. */
  planted: boolean
  hits: number
  /** Card as it was when the step fired, for reading it again later. */
  card: TourCard | null
  /**
   * The step's checks have held at least once. A `retry:` step is not done
   * until they have, and it stays done after.
   */
  passed: boolean
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off'
  } catch {
    return true // private mode, blocked storage
  }
}

let state: TourState = { ...EMPTY, enabled: readEnabled() }
let steps: StepRuntime[] = []
let lineIndex: LineIndex | null = null
let lineIndexFor: Uint8Array | null = null
/** Member offsets by struct name, for `k_msgq(q).used_msgs`; see layout(). */
let layouts = new Map<string, Record<string, number>>()
let layoutsFor: Uint8Array | null = null
let demoTimer: ReturnType<typeof setTimeout> | undefined
let armWatchdog: ReturnType<typeof setTimeout> | undefined
/**
 * The step the stop filter decided on, waiting for the full stop to land.
 * Hits are counted once, in the filter; this carries the verdict across.
 */
let pendingFire: StepRuntime | null = null
/**
 * Shipped sources by their path under `src/<app>/`, lowercased, fetched for
 * pattern anchors and highlights.
 */
let sources = new Map<string, string[]>()
/** How to reach a shipped source file — the board and sample live in App. */
let sourceUrl: ((file: string) => string) | null = null
/**
 * The image's list of what it shipped beside the sample. Resolves to null for
 * an image built before there was one: those shipped only the sample's own
 * files, and each is found by its basename.
 */
let shipped: Promise<SourceIndex | null> = Promise.resolve(null)
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function publish(next: Partial<TourState>) {
  state = { ...state, ...next }
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): TourState {
  return state
}

/** Runtime view of the outline, for the progress dots. */
export function getSteps(): StepRuntime[] {
  return steps
}

/* ------------------------------------------------------------------ *
 * The target
 * ------------------------------------------------------------------ */

/**
 * The line table, built once per image and only when a tour needs it.
 *
 * Parsing `.debug_line` out of a Zephyr ELF is not free, and every sample that
 * has no tour would be paying for nothing.
 */
function lines(): LineIndex | null {
  const elf = gdb.getKernelElf()
  if (!elf) return null
  if (lineIndexFor !== elf) {
    lineIndexFor = elf
    try {
      lineIndex = buildLineIndex(elf)
    } catch {
      lineIndex = null
    }
  }
  return lineIndex
}

/**
 * Member offsets of `struct name` in the running image, read from its DWARF
 * once and kept for as long as the image is.
 *
 * Misses are kept too: a struct the build does not describe costs a walk of
 * the whole of `.debug_info`, tens of milliseconds on a large image.
 */
function layout(name: string): Record<string, number> {
  const elf = gdb.getKernelElf()
  if (!elf) return {}
  if (layoutsFor !== elf) {
    layoutsFor = elf
    layouts = new Map()
  }
  let members = layouts.get(name)
  if (!members) {
    try {
      members = dwarfStructMembers(elf, name)
    } catch {
      members = {}
    }
    layouts.set(name, members)
  }
  return members
}

function memberOffset(struct: string, member: string): number | null {
  const members = layout(struct)
  return Object.hasOwn(members, member) ? members[member]! : null
}

function liveTarget(): TourTarget {
  const snap = gdb.getSnapshot()
  const index = gdb.getSymbolIndex()
  const regs = registerValues(snap.registers)
  return {
    pointerBytes: snap.regArch === 'aarch64' ? 8 : 4,
    symbol(name) {
      // Data first: a tour that says `led` means the variable, and a function
      // of the same name would be a surprising thing to read bytes out of.
      const object = index?.objects.get(name)
      if (object) return object.addr
      const fn = index?.byName.find((s) => s.name === name)
      return fn ? normalizeAddr(fn.addr, snap.regArch) : null
    },
    register(name) {
      return regs.get(name) ?? null
    },
    async read(addr, length) {
      return debug.readMemoryRaw(addr >>> 0, length)
    },
    label(addr) {
      // Data first here too: an object with a size says exactly where it ends,
      // while a function with none would claim whatever follows it.
      return formatSymbol(resolveDataSymbol(index, addr) ?? resolveSymbol(index, addr))
    },
    member: memberOffset,
  }
}

/* ------------------------------------------------------------------ *
 * Loading and arming
 * ------------------------------------------------------------------ */

/*
 * Cached by sample id, misses included: a sample with no tour is as cacheable
 * as one with them. Same shape as the .dts cache in src/devicetree.ts.
 */
const cache = new Map<string, TourDoc | null>()

/**
 * Parse a sample's tour. Never throws — a sample with no tour file, and a
 * document with no steps, both read as "no tour here".
 */
export async function fetchTour(sampleId: string): Promise<TourDoc | null> {
  const cached = cache.get(sampleId)
  if (cached !== undefined) return cached
  const text = await loadTourSource(sampleId)
  const parsed = text === null ? null : parseTour(text)
  const doc = parsed && parsed.steps.length > 0 ? parsed : null
  cache.set(sampleId, doc)
  return doc
}

/**
 * Point the store at the running sample's tour. Safe to call when absent.
 *
 * `sourceFor` maps a path under the sample's shipped sources (`main.c`,
 * `zephyr/kernel/msg_q.c`, `index.json`) to its URL; a tour that anchors by
 * pattern needs the text to search, and only the caller knows which board's
 * assets are in play. Those come from the image build, so they can be absent
 * where the tour itself never is.
 */
export async function loadFor(
  sampleId: string,
  sourceFor?: (file: string) => string,
): Promise<void> {
  sourceUrl = sourceFor ?? null
  const doc = await fetchTour(sampleId)
  if (!doc) return
  // Started now, awaited when arming: a fetch must not hold up the attach
  // hook below, which has to be in place before the stub opens.
  shipped = sourceFor ? fetchIndex(sourceFor('index.json')) : Promise.resolve(null)
  steps = doc.steps.map((step) => ({
    step,
    anchor: null,
    unresolved: false,
    planted: false,
    hits: 0,
    card: null,
    passed: false,
  }))
  publish({
    doc,
    problems: [...doc.problems],
    finished: false,
    completed: false,
    waiting: null,
    seen: new Set(),
  })
  // Plant at the stop that opening the stub produces, before the machine runs
  // on. If the session is already up — a tour loaded after boot — plant now and
  // accept that anything already executed is behind us.
  gdb.setAttachHook(arm)
  gdb.setStopFilter(claimStop)
  if (gdb.sessionActive()) void arm()

  /*
   * A tour that never arms should say which of the ways it failed, not sit
   * there looking like a sample with no tour. The reader sees the same nothing
   * whether the images are older than the tour, the gdbstub never attached, or
   * every anchor missed. Only the first of those is something they can do
   * anything about.
   */
  if (armWatchdog !== undefined) clearTimeout(armWatchdog)
  armWatchdog = setTimeout(() => {
    if (!state.armed) {
      console.warn(
        gdb.getSnapshot().attached
          ? '[tour] gdb is attached but no step armed — see the problems above'
          : '[tour] no gdb session, so the tour cannot break anywhere.',
      )
      return
    }
    // Armed, and the machine has been stopped for a while with no card: the
    // stops are not reaching the tour at all. That was a real bug once — a
    // cleared stop filter — and it looked exactly like a tour that had simply
    // not been reached yet, which is why it is worth naming.
    if (gdb.getSnapshot().paused && state.current === null && state.seen.size === 0) {
      console.warn(
        '[tour] breakpoints are planted and the machine is stopped, but no step ' +
          'claimed the stop. The tour is armed and not listening.',
      )
    }
  }, ARM_GRACE_MS)
}

/**
 * Arm the tour: resolve every anchor, then plant only the step the reader is
 * actually waiting on.
 *
 * Resolving is done up front — it is pure lookup in the ELF, it costs the guest
 * nothing, and doing it all at once is what lets the outline and the problem
 * list be honest before the first step fires.
 *
 * *Planting* is one at a time. A breakpoint is a trap on every pass, so a tour
 * with every step planted has the guest trapping into the page at addresses
 * nobody is looking at yet — for the whole run, including steps the reader may
 * never reach. It also let a later step fire before an earlier one, which reads
 * as the tour jumping about.
 *
 * The cost of linearity is that a step whose location is passed before its turn
 * comes round is simply missed — the guest reaches it again on a later pass, or
 * not at all. That is the right trade for a document with numbered steps, and
 * it is what the prose already implies.
 */
export async function arm(): Promise<void> {
  if (!state.enabled || steps.length === 0) return
  await loadPatternSources()
  const context = {
    symbols: gdb.getSymbolIndex(),
    lines: lines(),
    arch: gdb.getSnapshot().regArch,
    sources,
  }
  const problems = [...(state.doc?.problems ?? [])]

  for (const runtime of steps) {
    if (runtime.anchor) continue
    const result = resolveAnchor(runtime.step.at, context)
    if (!result.ok) {
      problems.push(`step ${runtime.step.index + 1}: ${result.error}`)
      runtime.unresolved = true
      continue
    }
    runtime.anchor = result.anchor
  }

  const planted = await plantNext()

  if (armWatchdog !== undefined) clearTimeout(armWatchdog)
  armWatchdog = undefined
  /*
   * Say something when a tour cannot run. Until now this was silent in
   * production: the gallery badges the sample as guided, the reader waits, and
   * nothing ever happens — indistinguishable from a sample with no tour. The
   * usual cause is an image tarball older than the tour (no shipped sources for
   * a pattern anchor to search), which is worth being able to see from the
   * console rather than by reading this file.
   */
  if (problems.length > 0) {
    console.warn(`[tour] ${problems.length} step(s) could not be armed:\n  ${problems.join('\n  ')}`)
  }
  if (!planted) console.warn('[tour] no step resolved against this build; the tour will not run')
  // A first step that waits on the reader says so from the start.
  publish({
    armed: planted,
    live: true,
    problems,
    waiting: state.current === null ? promptNext() : null,
  })
}

/**
 * A `retry:` step that has fired and not passed. It keeps its breakpoint, and
 * the tour waits on it instead of moving past.
 */
function retrying(runtime: StepRuntime): boolean {
  return runtime.step.retry && runtime.card !== null && !runtime.passed
}

/**
 * Plant the next step that still wants a breakpoint, if it has none.
 *
 * A `retry:` step that has not passed comes first and holds the line: nothing
 * after it goes in until it passes, so the next hit the reader causes is a new
 * try at it, not a later step jumping in.
 *
 * Awaited before any resume, always: `main()` and the line after it are
 * microseconds apart on a JIT guest, so planting after letting go would lose
 * the step every time.
 */
async function plantNext(): Promise<boolean> {
  const runtime = steps.find(
    (s) =>
      !s.unresolved &&
      s.anchor !== null &&
      (retrying(s) || (!s.planted && (s.card === null || s.step.repeat))),
  )
  if (!runtime?.anchor) return steps.some((s) => s.planted)
  if (runtime.planted) return true
  runtime.planted = await debug.addBreakpoint(runtime.anchor.addr)
  if (runtime.planted) ownedBreakpoints.add(runtime.anchor.addr)
  if (!runtime.planted) {
    publish({
      problems: [
        ...state.problems,
        `step ${runtime.step.index + 1}: the stub refused a breakpoint at \`${runtime.step.at}\``,
      ],
    })
  }
  return steps.some((s) => s.planted)
}

/** The your-turn prompt a step puts up while the tour waits on it, if any. */
function waitingOf(runtime: StepRuntime | undefined): TourWaiting | null {
  const text = runtime?.step.await
  if (!runtime || !text) return null
  return { index: runtime.step.index, text, do: runtime.step.do, notes: lookNotes(runtime.step) }
}

/**
 * The prompt for the step the guest is running towards (planted, and either
 * not yet fired or retrying), opening what that step points at as well. The
 * reader acts now, and "watch the queue fill" means the Queues tab while it
 * fills, not once it has. A retry asks for the same thing again.
 */
function promptNext(): TourWaiting | null {
  const runtime = steps.find((s) => s.planted && (s.card === null || retrying(s)))
  const waiting = waitingOf(runtime)
  if (waiting) focusStep(runtime!.step)
  return waiting
}

/**
 * Read the image's `src/<app>/index.json`. Null when there is none, which is
 * every image built before the build wrote one.
 */
async function fetchIndex(url: string): Promise<SourceIndex | null> {
  try {
    const res = await fetch(url)
    // The dev server answers an unknown path with index.html and a 200.
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return null
    return parseSourceIndex(await res.json())
  } catch {
    return null
  }
}

/**
 * Fetch the sources any `at: file.c:/pattern/` step needs to search.
 *
 * Only files a pattern names: an anchor by line or symbol never reads the
 * text, and the excerpt under the card fetches lazily on its own.
 */
async function loadPatternSources(): Promise<void> {
  if (!sourceUrl) return
  const index = await shipped
  const wanted = new Set<string>()
  for (const runtime of steps) {
    const file = patternFile(runtime.step.at)
    if (!file) continue
    // The index finds `msg_q.c` under zephyr/kernel/. Without one, only the
    // sample's own files were shipped, each at its basename.
    const path = index ? shippedFileNamed(file, index) : file
    if (path && !sources.has(path.toLowerCase())) wanted.add(path)
  }
  await Promise.all([...wanted].map(loadSource))
}

/**
 * One shipped file's lines, fetched once. Undefined when it is not there: a
 * tour whose sources were not shipped falls back to saying so.
 */
async function loadSource(path: string): Promise<string[] | undefined> {
  const key = path.toLowerCase()
  if (sources.has(key) || !sourceUrl) return sources.get(key)
  try {
    const res = await fetch(sourceUrl(path))
    if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return undefined
    const text = await res.text()
    if (text.trimStart().startsWith('<')) return undefined
    sources.set(key, text.split('\n'))
  } catch {
    // Absence reads the same as a network failure.
  }
  return sources.get(key)
}

/** Drop every planted breakpoint — leaving the tour, or turning tours off. */
async function disarm(): Promise<void> {
  for (const runtime of steps) runtime.planted = false
  const addrs = [...ownedBreakpoints]
  ownedBreakpoints.clear()
  for (const addr of addrs) await debug.removeBreakpoint(addr)
  // Stop claiming hits once the tour is over; leftover filters look like a
  // stuck pause when the reader finishes the last step.
  gdb.setStopFilter(null)
  publish({ armed: false })
}

/* ------------------------------------------------------------------ *
 * Stops
 * ------------------------------------------------------------------ */

let wasPaused = false
let pauseEpoch = 0
let handledEpoch = -1
/**
 * Addresses this tour inserted. A step marks itself unplanted before the
 * stub has actually dropped the breakpoint, and "Got it" on a `stop: no`
 * step can run in that window. Disarm removes these, not the planted flag.
 */
const ownedBreakpoints = new Set<number>()

/**
 * Decide, at the raw stop, whether this hit is one the reader should see.
 *
 * This runs before the debugger has done anything expensive, and it is the
 * only place hits are counted. A step conditioned on `hits % 10 == 0` rejects
 * nine hits out of ten and each rejection costs one register read, a step off
 * the breakpoint and a continue: no pause published, no thread walk, no card.
 * Without that, a condition on anything hotter than a once-a-second blink
 * would be unusable, and `when:` would be a promise the implementation could
 * not keep.
 *
 * Returning true means "not this one, let it go".
 */
function claimStop(stop: gdb.StopContext): boolean {
  if (!state.enabled) return false
  const pc = normalizeAddr(Number.parseInt(stop.pc, 16), gdb.getSnapshot().regArch)
  if (!Number.isFinite(pc)) return false

  /*
   * More than one step can sit on the same address — "the line that does the
   * work" and "the same line, ten passes later" are both about the toggle in
   * blinky's loop. Every step there counts the hit; the first whose condition
   * fires is the one shown, preferring one the reader has not seen.
   */
  const here = steps.filter((s) => s.planted && s.anchor?.addr === pc)
  // Somebody else's breakpoint, or the reader hit Pause. Not ours to swallow.
  if (here.length === 0) return false

  // A card is already up (a `stop: no` step, with the guest still running).
  // Swallow without counting, so a `when: first` step further on is still
  // waiting to happen rather than quietly used up.
  if (state.current !== null) return true

  // A `retry:` step that has not passed holds the tour on it. A later step
  // whose breakpoint went in early is not its turn yet: let it go, uncounted.
  const holding = steps.find(retrying)
  const eligible = holding ? here.filter((s) => s.step.index <= holding.step.index) : here
  if (eligible.length === 0) return true

  const firing: StepRuntime[] = []
  for (const candidate of eligible) {
    candidate.hits++
    const verdict = whenFires(candidate.step.when, candidate.hits)
    if (verdict.invalid) {
      publish({
        problems: [
          ...state.problems,
          `step ${candidate.step.index + 1}: \`when: ${candidate.step.when}\` is not a hit condition`,
        ],
      })
    }
    if (verdict.fires) firing.push(candidate)
  }

  const runtime = firing.find((s) => s.card === null) ?? firing[0]
  if (!runtime) return true // counted, not wanted: run on

  pendingFire = runtime
  return false
}

/**
 * Watch the debugger for the stops the filter kept.
 *
 * A stop is only interesting once the registers have been read back, which is
 * when the PC is known; before that the snapshot still holds the previous
 * stop's. `pauseEpoch` is what keeps one stop from being handled twice as the
 * memory and thread reads land and re-publish.
 */
function onDebugChange() {
  const snap = gdb.getSnapshot()
  if (!snap.paused) {
    wasPaused = false
    return
  }
  if (!wasPaused) {
    wasPaused = true
    pauseEpoch++
  }
  if (snap.registersLoading || !snap.pc) return
  if (handledEpoch === pauseEpoch) return
  handledEpoch = pauseEpoch
  void showPending()
}

gdb.subscribe(onDebugChange)

/** Put up the card for the step the filter picked, if there was one. */
async function showPending(): Promise<void> {
  const runtime = pendingFire
  pendingFire = null
  if (!runtime || !state.enabled || state.current !== null) return

  const card = await buildCard(runtime)
  runtime.card = card
  if (card.check?.outcome === 'passed') runtime.passed = true
  // A retry keeps its breakpoint for the reader's next try, and counts that
  // try's hits from zero so a `when:` applies to each try the same way.
  const again = retrying(runtime)
  if (again) runtime.hits = 0

  if (!runtime.step.repeat && !again && runtime.anchor) {
    const addr = runtime.anchor.addr
    runtime.planted = false
    // The address may still belong to another step; only lift the breakpoint
    // once nothing is waiting on it. Await the lift before anything resumes:
    // a `stop: no` step continues in this same turn, and "Got it" can dismiss
    // the card while that continue is still queued. The address stays in
    // ownedBreakpoints until the stub has actually dropped it, so finish
    // still removes it if the reader gets there first.
    if (!steps.some((s) => s.planted && s.anchor?.addr === addr)) {
      await debug.removeBreakpoint(addr)
      ownedBreakpoints.delete(addr)
    }
  }

  // Reveal before the card lands, so the row the step is about is already in
  // view when the reader's eye goes looking for it.
  focusStep(runtime.step)

  const seen = new Set(state.seen)
  seen.add(runtime.step.index)
  publish({ current: card, waiting: null, seen, armed: steps.some((s) => s.planted) })

  // `stop: no` is a note the reader can read while the guest carries on — the
  // card stays, the machine does not. Plant the next step before letting go, or
  // the guest reaches it while we are still asking for the breakpoint.
  if (!runtime.step.stop) {
    await plantNext()
    publish({ armed: steps.some((s) => s.planted) })
    debug.resume()
  }
}

/**
 * Resolve a `mark:` range. Both ends are expressions so `1p..2p` can mean the
 * word after the first pointer whatever the guest's word size is.
 */
async function evalMark(
  mark: { start: string; end: string } | null,
  target: TourTarget,
): Promise<{ start: number; end: number } | null> {
  if (!mark) return null
  try {
    const start = await evalAddress(mark.start, target)
    const end = await evalAddress(mark.end, target)
    return end > start ? { start, end } : null
  } catch {
    return null
  }
}

/**
 * Read the focused message queue's ring now, while the machine is halted.
 *
 * Everything else in `objects:` comes from the debugger's walk as the card
 * renders. A ring drawn that way would open on the previous stop's pointers,
 * because the walk lands a beat after the card, and on a revisit it would put
 * the current pointers under an earlier step's prose. Where R and W sit *at this
 * stop* is the lesson, so they are read here with the buffer behind them, the
 * same rule `memory:` follows. Null when the image has no object cores or the
 * focus is not a queue: the card keeps the plain row.
 */
async function readRing(addr: number, target: TourTarget): Promise<MsgqRingSnapshot | null> {
  const meta = gdb.getObjectCoreMeta()
  if (!meta) return null
  return readMsgqRing(meta, addr, (at, length) => target.read(at, length))
}

/**
 * Turn a step's `highlight:` entries into line ranges.
 *
 * Patterns are searched in the same shipped source the excerpt is drawn from,
 * so a highlight and the code under it cannot disagree. A pattern that matches
 * nothing is dropped rather than guessed at: a highlight over the wrong lines
 * is worse than none.
 */
async function resolveHighlights(step: TourStep, path: string | null): Promise<TourHighlight[]> {
  // Line numbers need no text, so only fetch it for a pattern.
  const text =
    path && step.highlight.some((spec) => spec.kind === 'pattern') ? await loadSource(path) : undefined
  return resolveHighlightSpecs(step.highlight, text)
}

/**
 * Where a stop's file was shipped, under `src/<app>/`. The image's index
 * knows; an image without one shipped only the sample's own files, so the
 * basename is the only guess there is, and the card has always made it.
 */
function shippedFile(file: string | null, index: SourceIndex | null): string | null {
  if (file === null) return null
  return index ? shippedPathFor(file, index) : file.slice(file.lastIndexOf('/') + 1)
}

/** Only `passed` is a pass: a row that could not be read is not one that held. */
function checkOutcome(rows: TourCheckRow[]): TourCheck['outcome'] {
  if (rows.some((row) => row.pass === false)) return 'failed'
  return rows.every((row) => row.pass === true) ? 'passed' : 'unknown'
}

/**
 * Evaluate a step's `check:` rows against the stopped guest. Only ever reads.
 *
 * Each row keeps the sides that were read, with what the guest had, since that
 * is what a reader whose check failed needs to see. Bare numbers are left out:
 * they are already in the row as written.
 */
async function evalChecks(runtime: StepRuntime, target: TourTarget): Promise<TourCheck | null> {
  const { step } = runtime
  if (step.check.length === 0) return null
  const rows: TourCheckRow[] = []
  for (const predicate of step.check) {
    const result = await evalPredicate(predicate, target)
    const sides = [
      { operand: predicate.lhs, read: result.lhs },
      { operand: predicate.rhs, read: result.rhs },
    ]
    rows.push({
      text: predicate.text,
      pass: result.error === null ? result.pass : null,
      values: sides
        .filter(({ operand }) => operand.literal === null)
        .map(({ operand, read }) => ({
          expr: operand.expr,
          text: read.text,
          ok: read.value !== null,
        })),
    })
  }
  const outcome = checkOutcome(rows)
  return { rows, outcome, retrying: step.retry && outcome !== 'passed' && !runtime.passed }
}

async function buildCard(runtime: StepRuntime): Promise<TourCard> {
  const { step } = runtime
  const target = liveTarget()
  const snap = gdb.getSnapshot()

  const values: TourValue[] = []
  for (const watch of step.watch) {
    const result = await evalWatch(watch.expr, watch.format, target)
    values.push({
      label: watch.label ?? watch.expr,
      expr: watch.expr,
      format: watch.format,
      text: result.text,
      detail: result.detail,
      ok: result.ok,
    })
  }

  const check = await evalChecks(runtime, target)

  let memory: TourMemory | null = null
  if (step.memory) {
    const spec = step.memory
    try {
      const addr = await evalAddress(spec.at, target)
      const bytes = await target.read(addr >>> 0, spec.len)
      memory = {
        addr: addr >>> 0,
        bytes,
        len: spec.len,
        mark: await evalMark(spec.mark, target),
        note: spec.note,
        error: bytes ? null : 'unreadable',
      }
    } catch (err) {
      memory = {
        addr: null,
        bytes: null,
        len: spec.len,
        mark: null,
        note: spec.note,
        error: err instanceof Error ? err.message : 'bad address',
      }
    }
  }

  let objects: TourObjects | null = null
  if (step.objects) {
    const spec = step.objects
    // A focus that will not evaluate costs the highlight, not the list.
    const focus = spec.focus === null ? null : await evalAddress(spec.focus, target).catch(() => null)
    objects = {
      types: spec.types,
      focus,
      ring: spec.view === 'ring' && focus !== null ? await readRing(focus, target) : null,
    }
  }

  const regs = registerValues(snap.registers)
  const registers = step.registers.map((name) => {
    const value = regs.get(name.toLowerCase())
    return {
      name: name.toUpperCase(),
      value: value === undefined ? 'n/a' : `0x${value.toString(16)}`,
    }
  })

  const index = await shipped
  const source = shippedFile(runtime.anchor?.file ?? null, index)

  return {
    step,
    anchor: runtime.anchor,
    paused: step.stop,
    hits: runtime.hits,
    values,
    check,
    memory,
    objects,
    registers,
    threads: step.threads,
    highlight: await resolveHighlights(step, source),
    lookNotes: lookNotes(step),
    source,
    provenance: index && source ? provenance(source) : null,
  }
}

/* ------------------------------------------------------------------ *
 * Reader controls
 * ------------------------------------------------------------------ */

/**
 * Dismiss the card and let the machine run to the next step.
 *
 * The next breakpoint goes in *before* the resume. `main()` and the line after
 * it are microseconds apart on a JIT guest, so a plant that races the resume
 * loses the step — reliably, not occasionally.
 *
 * When every step has had its turn, and every `retry:` step has passed, drop
 * every remaining breakpoint so the guest free-runs instead of trapping on a
 * leftover stop, and say the tour is complete: that is what puts up its outro.
 * A retry still failing is a turn not yet over.
 */
export function next(): void {
  const card = state.current
  publish({ current: null })
  void (async () => {
    const finished = steps.every((s) => s.unresolved || (s.card !== null && !retrying(s)))
    if (finished) {
      await disarm()
      publish({ armed: false, finished: true, completed: true, waiting: null })
      if (state.live && (card?.paused || gdb.getSnapshot().paused)) debug.resume()
      return
    }
    const planted = await plantNext()
    publish({ armed: planted, finished: false, waiting: promptNext() })
    if (card?.paused && state.live) debug.resume()
  })()
}

/** Read a step again, without touching the machine. */
export function revisit(index: number): void {
  const runtime = steps[index]
  if (!runtime?.card) return
  // Never claims a pause: the machine has moved on since, and saying otherwise
  // would be a straight lie about what the reader is looking at.
  publish({ current: { ...runtime.card, paused: false } })
}

/** Leave the tour: drop the breakpoints, resume, say nothing more. */
export function skip(): void {
  const wasStopped = state.current?.paused ?? false
  publish({ current: null, waiting: null, finished: true, completed: false })
  void (async () => {
    await disarm()
    publish({ armed: false, finished: true })
    if (state.live && (wasStopped || gdb.getSnapshot().paused)) debug.resume()
  })()
}

/** Close the completion card. The tour is already over, so nothing else changes. */
export function dismissCompletion(): void {
  publish({ completed: false })
}

/** Drop everything — a new guest is starting. */
export function reset(): void {
  if (demoTimer !== undefined) clearTimeout(demoTimer)
  demoTimer = undefined
  if (armWatchdog !== undefined) clearTimeout(armWatchdog)
  armWatchdog = undefined
  gdb.setAttachHook(null)
  gdb.setStopFilter(null)
  pendingFire = null
  steps = []
  sources = new Map()
  sourceUrl = null
  shipped = Promise.resolve(null)
  lineIndex = null
  lineIndexFor = null
  layouts = new Map()
  layoutsFor = null
  wasPaused = false
  handledEpoch = -1
  ownedBreakpoints.clear()
  state = { ...EMPTY, enabled: state.enabled, seen: new Set() }
  notify()
}

/* ------------------------------------------------------------------ *
 * The mock backend's replay
 * ------------------------------------------------------------------ */

/** Beat between steps when nothing is waiting on the reader. */
const DEMO_STEP_MS = 3200

/**
 * Walk a tour with no machine underneath it.
 *
 * `npm run dev` lands on the mock backend, which is exactly the audience a
 * teaching feature is for. There is no guest to break in, so the steps advance
 * on a timer and every card that would have read the target says so instead of
 * inventing a number — a fabricated `pin = 4` on a page whose whole premise is
 * "this is really running" would be the wrong kind of convincing.
 */
export function startDemo(sampleId: string, signal: AbortSignal): () => void {
  void fetchTour(sampleId).then((doc) => {
    if (!doc || signal.aborted) return
    steps = doc.steps.map((step) => ({
    step,
    anchor: null,
    unresolved: false,
    planted: false,
    hits: 0,
    card: null,
    passed: false,
  }))
    publish({
      doc,
      live: false,
      armed: false,
      problems: [...doc.problems],
      finished: false,
      completed: false,
      waiting: null,
    })

    let index = 0
    /** The step whose your-turn beat has been shown, so each gets exactly one. */
    let prompted = -1
    const tick = () => {
      // Leaving the tour ends the replay too, or the next beat puts a card back.
      if (signal.aborted || !state.enabled || state.finished) return
      const runtime = steps[index]
      if (!runtime) {
        publish({ current: null, waiting: null, finished: true, completed: true })
        return
      }
      // A step that waits on the reader gets a beat of its own first, the way
      // its your-turn card stays up while the reader does what it asks.
      const waiting = waitingOf(runtime)
      if (waiting && prompted !== index) {
        prompted = index
        focusStep(runtime.step)
        publish({ current: null, waiting })
        demoTimer = setTimeout(tick, DEMO_STEP_MS)
        return
      }
      runtime.hits = 1
      runtime.card = demoCard(runtime)
      focusStep(runtime.step)
      const seen = new Set(state.seen)
      seen.add(index)
      publish({ current: runtime.card, waiting: null, seen })
      index++
      demoTimer = setTimeout(tick, DEMO_STEP_MS)
    }
    demoTimer = setTimeout(tick, DEMO_STEP_MS)
  })

  return () => {
    if (demoTimer !== undefined) clearTimeout(demoTimer)
    demoTimer = undefined
  }
}

function demoCard(runtime: StepRuntime): TourCard {
  const { step } = runtime
  return {
    step,
    anchor: null,
    paused: false,
    hits: 1,
    values: step.watch.map((watch) => ({
      label: watch.label ?? watch.expr,
      expr: watch.expr,
      format: watch.format,
      text: 'n/a',
      detail: null,
      ok: false,
    })),
    // Nothing was read, so nothing passed or failed: the card says Not checked.
    check:
      step.check.length > 0
        ? {
            rows: step.check.map((p) => ({ text: p.text, pass: null, values: [] })),
            outcome: 'unknown',
            retrying: false,
          }
        : null,
    memory: step.memory
      ? {
          addr: null,
          bytes: null,
          len: step.memory.len,
          mark: null,
          note: step.memory.note,
          error: null,
        }
      : null,
    objects: step.objects ? { types: step.objects.types, focus: null, ring: null } : null,
    registers: step.registers.map((name) => ({ name: name.toUpperCase(), value: 'n/a' })),
    threads: step.threads,
    highlight: resolveHighlightSpecs(step.highlight, undefined),
    lookNotes: lookNotes(step),
    source: null,
    provenance: null,
  }
}
