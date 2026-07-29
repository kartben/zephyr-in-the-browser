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
import { registerValues } from '@/debug/registerModel'
import { formatSymbol, resolveSymbol } from '@/debug/elfSymbols'
import * as debug from '@/debug/control'
import * as gdb from '@/hostGdb'
import { revealPanelKind } from '@/lib/dockReveal'
import { normalizeAddr, patternFile, resolveAnchor, type ResolvedAnchor } from '@/tours/anchors'
import { evalAddress, evalWatch, type TourTarget } from '@/tours/expr'
import { parseTour, type TourDoc, type TourStep } from '@/tours/parse'
import { whenFires } from '@/tours/when'

const ENABLED_KEY = 'zephyr-tours-enabled'

/** One evaluated `watch:` row. */
export interface TourValue {
  label: string
  expr: string
  format: string
  text: string
  detail: string | null
  ok: boolean
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

export interface TourCard {
  step: TourStep
  /** Where the breakpoint actually landed. */
  anchor: ResolvedAnchor | null
  /** The machine is stopped underneath this card. */
  paused: boolean
  /** Which time through this was. */
  hits: number
  values: TourValue[]
  memory: TourMemory | null
  registers: Array<{ name: string; value: string }>
  threads: boolean
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
  /** Step indexes already shown. */
  seen: Set<number>
  finished: boolean
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
  seen: new Set(),
  finished: false,
  problems: [],
}

export interface StepRuntime {
  step: TourStep
  anchor: ResolvedAnchor | null
  /** Breakpoint is currently planted. */
  planted: boolean
  hits: number
  /** Card as it was when the step fired, for reading it again later. */
  card: TourCard | null
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
let demoTimer: ReturnType<typeof setTimeout> | undefined
/** Shipped sources by basename, fetched for pattern anchors. */
let sources = new Map<string, string[]>()
/** How to reach a shipped source file — the board and sample live in App. */
let sourceUrl: ((file: string) => string) | null = null
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
      return formatSymbol(resolveSymbol(index, addr))
    },
  }
}

/* ------------------------------------------------------------------ *
 * Loading and arming
 * ------------------------------------------------------------------ */

/*
 * Cached by URL, misses included: a sample with no tour is as cacheable as one
 * with them. Same shape as the .dts cache in src/devicetree.ts.
 */
const cache = new Map<string, TourDoc | null>()

/**
 * Fetch and parse a tour. Never throws — a missing file, a dev server answering
 * with index.html, or a document with no steps all read as "no tour here".
 */
export async function fetchTour(url: string): Promise<TourDoc | null> {
  const cached = cache.get(url)
  if (cached !== undefined) return cached
  let doc: TourDoc | null = null
  try {
    const res = await fetch(url)
    if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) {
      const text = await res.text()
      if (!text.trimStart().startsWith('<')) {
        const parsed = parseTour(text)
        doc = parsed.steps.length > 0 ? parsed : null
      }
    }
  } catch {
    // Absence and network failure are the same thing here.
  }
  cache.set(url, doc)
  return doc
}

/**
 * Point the store at the running sample's tour. Safe to call when absent.
 *
 * `sourceFor` maps a file's basename to the URL its shipped copy lives at; a
 * tour that anchors by pattern needs the text to search, and only the caller
 * knows which board's assets are in play.
 */
export async function loadFor(url: string, sourceFor?: (file: string) => string): Promise<void> {
  sourceUrl = sourceFor ?? null
  const doc = await fetchTour(url)
  if (!doc) return
  steps = doc.steps.map((step) => ({ step, anchor: null, planted: false, hits: 0, card: null }))
  publish({ doc, problems: [...doc.problems], finished: false, seen: new Set() })
  // Plant at the stop that opening the stub produces, before the machine runs
  // on. If the session is already up — a tour loaded after boot — plant now and
  // accept that anything already executed is behind us.
  gdb.setAttachHook(arm)
  if (gdb.sessionActive()) void arm()
}

/**
 * Resolve every step and plant its breakpoint.
 *
 * Steps are planted all at once rather than one ahead of the reader, because a
 * tour is not necessarily linear: a `when: hits % 100 == 0` step deep in a loop
 * and a one-shot step in `main()` are both armed from the start, and whichever
 * the guest reaches first is the one that fires.
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
    if (runtime.planted) continue
    const result = resolveAnchor(runtime.step.at, context)
    if (!result.ok) {
      problems.push(`step ${runtime.step.index + 1}: ${result.error}`)
      continue
    }
    runtime.anchor = result.anchor
    runtime.planted = await debug.addBreakpoint(result.anchor.addr)
    if (!runtime.planted) {
      problems.push(`step ${runtime.step.index + 1}: the stub refused a breakpoint at \`${runtime.step.at}\``)
    }
  }
  publish({ armed: steps.some((s) => s.planted), live: true, problems })
}

/**
 * Fetch the sources any `at: file.c:/pattern/` step needs to search.
 *
 * Only files a pattern names: an anchor by line or symbol never reads the
 * text, and the excerpt under the card fetches lazily on its own.
 */
async function loadPatternSources(): Promise<void> {
  if (!sourceUrl) return
  const wanted = new Set<string>()
  for (const runtime of steps) {
    const file = patternFile(runtime.step.at)
    if (file && !sources.has(file)) wanted.add(file)
  }
  await Promise.all(
    [...wanted].map(async (file) => {
      try {
        const res = await fetch(sourceUrl!(file))
        if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return
        const text = await res.text()
        if (text.trimStart().startsWith('<')) return
        sources.set(file, text.split('\n'))
      } catch {
        // A tour whose sources were not shipped falls back to saying so.
      }
    }),
  )
}

/** Drop every planted breakpoint — leaving the tour, or turning tours off. */
async function disarm(): Promise<void> {
  for (const runtime of steps) {
    if (!runtime.planted || !runtime.anchor) continue
    runtime.planted = false
    await debug.removeBreakpoint(runtime.anchor.addr)
  }
  publish({ armed: false })
}

/* ------------------------------------------------------------------ *
 * Stops
 * ------------------------------------------------------------------ */

let wasPaused = false
let pauseEpoch = 0
let handledEpoch = -1

/**
 * Watch the debugger for stops that belong to this tour.
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
  const pc = normalizeAddr(Number.parseInt(snap.pc, 16), snap.regArch)
  if (Number.isFinite(pc)) void onStop(pc)
}

gdb.subscribe(onDebugChange)

async function onStop(pc: number): Promise<void> {
  if (!state.enabled || state.current !== null) return
  /*
   * More than one step can sit on the same address — "the line that does the
   * work" and "the same line, forty passes later" are both about the toggle in
   * blinky's loop. Every step there counts the hit; the first whose condition
   * fires is the one shown, preferring one the reader has not seen.
   */
  const here = steps.filter((s) => s.planted && s.anchor?.addr === pc)
  // Somebody else's breakpoint, or the reader hit Pause. Not ours to resume.
  if (here.length === 0) return

  const firing: StepRuntime[] = []
  for (const candidate of here) {
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
  if (!runtime) {
    // No step wanted this pass. Slip past without the reader seeing the stop.
    debug.resume()
    return
  }

  const card = await buildCard(runtime)
  runtime.card = card

  if (!runtime.step.repeat) {
    runtime.planted = false
    // The address may still belong to another step; only lift the breakpoint
    // once nothing is waiting on it.
    if (!steps.some((s) => s.planted && s.anchor?.addr === pc)) {
      void debug.removeBreakpoint(pc)
    }
  }

  // Reveal before the card lands, so the row the step is about is already in
  // view when the reader's eye goes looking for it.
  if (runtime.step.panel) revealPanelKind(runtime.step.panel)

  const seen = new Set(state.seen)
  seen.add(runtime.step.index)
  publish({ current: card, seen, armed: steps.some((s) => s.planted) })

  // `stop: no` is a note the reader can read while the guest carries on — the
  // card stays, the machine does not.
  if (!runtime.step.stop) debug.resume()
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

  const regs = registerValues(snap.registers)
  const registers = step.registers.map((name) => {
    const value = regs.get(name.toLowerCase())
    return {
      name: name.toUpperCase(),
      value: value === undefined ? '—' : `0x${value.toString(16)}`,
    }
  })

  return {
    step,
    anchor: runtime.anchor,
    paused: step.stop,
    hits: runtime.hits,
    values,
    memory,
    registers,
    threads: step.threads,
  }
}

/* ------------------------------------------------------------------ *
 * Reader controls
 * ------------------------------------------------------------------ */

/** Dismiss the card and let the machine run to the next step. */
export function next(): void {
  const card = state.current
  publish({ current: null, finished: steps.every((s) => s.card !== null) })
  if (card?.paused && state.live) debug.resume()
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
  void disarm()
  publish({ current: null, finished: true })
  if (wasStopped && state.live) debug.resume()
}

/**
 * Turn tours off for good (or back on).
 *
 * Turning them off has to resume a machine stopped on a step, or the reader is
 * left with a frozen guest and nothing on screen explaining why.
 */
export function setEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off')
  } catch {
    // Preference is a nicety; the toggle still works for this session.
  }
  const wasStopped = state.current?.paused ?? false
  publish({ enabled, current: enabled ? state.current : null })
  if (!enabled) {
    void disarm()
    if (wasStopped && state.live) debug.resume()
  } else if (gdb.sessionActive()) {
    void arm()
  }
}

/** Drop everything — a new guest is starting. */
export function reset(): void {
  if (demoTimer !== undefined) clearTimeout(demoTimer)
  demoTimer = undefined
  gdb.setAttachHook(null)
  steps = []
  sources = new Map()
  sourceUrl = null
  lineIndex = null
  lineIndexFor = null
  wasPaused = false
  handledEpoch = -1
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
export function startDemo(url: string, signal: AbortSignal): () => void {
  void fetchTour(url).then((doc) => {
    if (!doc || signal.aborted) return
    steps = doc.steps.map((step) => ({ step, anchor: null, planted: false, hits: 0, card: null }))
    publish({ doc, live: false, armed: false, problems: [...doc.problems] })

    let index = 0
    const tick = () => {
      if (signal.aborted || !state.enabled) return
      const runtime = steps[index]
      if (!runtime) {
        publish({ current: null, finished: true })
        return
      }
      runtime.hits = 1
      runtime.card = demoCard(runtime)
      if (runtime.step.panel) revealPanelKind(runtime.step.panel)
      const seen = new Set(state.seen)
      seen.add(index)
      publish({ current: runtime.card, seen })
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
      text: '—',
      detail: null,
      ok: false,
    })),
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
    registers: step.registers.map((name) => ({ name: name.toUpperCase(), value: '—' })),
    threads: step.threads,
  }
}
