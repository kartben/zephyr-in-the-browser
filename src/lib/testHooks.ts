/**
 * Hooks for the headless tour playthrough, `tools/tour-playthrough.mjs`.
 *
 * A tour is only proven by playing it. Every anchor can resolve and the guest
 * still never get there, or get there with a card that does not render. The
 * playthrough drives a real page in headless Chromium, and some of what a
 * reader does has no stable handle in the DOM: a GPIO key is a button in a dock
 * row that may be collapsed, and typing into the terminal from a script means
 * faking paste events on xterm's hidden textarea. So the page hands the harness
 * the calls its own controls make, and a summary of the tour it can poll.
 *
 * Installed only when the URL asks (`?test=1`). A reader's page has no
 * `window.__zitbTest`. Nothing here touches guest memory: a key press, a typed
 * line and a replayed gesture are what the reader's own hands do.
 */

import { sampleForSeed } from '@/boards'
import * as debug from '@/debug/control'
import { get as getDeviceTree } from '@/devicetree'
import { available as gpioAvailable, getButtons, setPressed, type Pin } from '@/hostGpio'
import { getState as getDockState } from '@/lib/dockStore'
import { replayingClip, startReplay } from '@/lib/followStore'
import * as terminal from '@/lib/terminalInput'
import { i2cModel } from '@/virtio'
import { isSensorChip, type SensorChip } from '@/virtio/devices/sensors/model'
import { RECORDING_SETS } from '@/virtio/devices/sensors/recordings'
import type { CiAction } from '@/tours/parse'
import { isCommandLine, resolvePlaceholders } from '@/tours/snippets'
import { getSnapshot as getTourState, getSteps } from '@/tours/store'

/**
 * How long a press holds the key down. Longer than the gpio-keys debounce in
 * the packaged images (30 ms), the way a click is: a key released before the
 * debounce settles reads as never pressed.
 */
const PRESS_HOLD_MS = 200

/** How long typing waits for the shell's prompt before it types anyway. */
const PROMPT_TIMEOUT_MS = 3000

/**
 * The longest a replayed gesture may take. A clip plays at the guest's reads,
 * or on a timer when the guest stops reading, so it always ends; this only
 * bounds a stuck page.
 */
const REPLAY_TIMEOUT_MS = 60_000

export type TestResult = { ok: true } | { ok: false; error: string }

/**
 * The tour store, flattened to plain data a harness can read across
 * `page.evaluate`. Steps are numbered from 1, as on the cards and in
 * `data-tour-step`.
 */
export interface TourStateSummary {
  /** A tour is loaded for the running sample. */
  loaded: boolean
  title: string | null
  enabled: boolean
  /** A breakpoint is planted and the tour is waiting for the guest to arrive. */
  armed: boolean
  /** A real gdb session drives the tour, not the mock backend's replay. */
  live: boolean
  steps: Array<{
    step: number
    title: string
    stop: boolean
    repeat: boolean
    await: string | null
    do: string[]
    ci: CiAction[]
  }>
  /** The tour ends on an outro, so finishing it puts up a completion card. */
  outro: boolean
  /** The step card on screen. */
  current: { step: number; paused: boolean } | null
  /** The your-turn card on screen. */
  waiting: { step: number } | null
  seen: number[]
  /** Steps whose breakpoint is planted right now. */
  planted: number[]
  /** Steps whose anchor did not resolve against this build. */
  unresolved: number[]
  finished: boolean
  completed: boolean
  problems: string[]
  /** The guest as the debugger sees it. */
  guest: { attached: boolean; paused: boolean }
}

export interface TestHooks {
  /** A momentary press of a `gpio-keys` button, by label or devicetree alias (`sw0`). */
  pressKey(label: string, holdMs?: number): Promise<TestResult>
  /** Type shell lines into the terminal, as a tour card's Run button would. */
  typeLines(lines: readonly string[]): Promise<TestResult>
  /**
   * Replay one of the running sample's recorded clips (`ring`), as its button
   * on the sensor card does. Resolves once the clip has played out.
   */
  replayGesture(id: string): Promise<TestResult>
  tourState(): TourStateSummary
}

declare global {
  interface Window {
    __zitbTest?: TestHooks
  }
}

/**
 * The `gpio-keys` button a name picks out, or null.
 *
 * Labels come from the guest's devicetree (`label = "Browser SW0"` on the
 * A53), or are the fallback `SW0` to `SW3`. So a name matches a whole label or
 * its last word, without case, and a whole-label match wins.
 *
 * When no label picks out one key, a devicetree alias can: `aliases` maps each
 * alias to the node it points at, as DtsInsights does. That is how `sw0` finds
 * the ESP32-C3's only key, which its board labels `User SW1`.
 */
export function findKey(
  buttons: readonly Pin[],
  name: string,
  aliases: Readonly<Record<string, string>> = {},
): Pin | null {
  const want = name.trim().toLowerCase()
  const label = (pin: Pin) => pin.label.trim().toLowerCase()
  const exact = buttons.filter((pin) => label(pin) === want)
  if (exact.length === 1) return exact[0]!
  const word = buttons.filter((pin) => label(pin).split(/\s+/).at(-1) === want)
  if (word.length === 1) return word[0]!
  const path = Object.hasOwn(aliases, want) ? aliases[want] : undefined
  if (path === undefined) return null
  const aliased = buttons.filter((pin) => pin.path === path)
  return aliased.length === 1 ? aliased[0]! : null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function pressKey(label: string, holdMs = PRESS_HOLD_MS): Promise<TestResult> {
  if (!gpioAvailable()) return { ok: false, error: 'this guest has no GPIO bridge to press a key on' }
  const buttons = getButtons()
  const pin = findKey(buttons, label, getDeviceTree()?.insights?.aliases)
  if (!pin) {
    const have = buttons.map((b) => b.label).join(', ') || 'none'
    return { ok: false, error: `no single GPIO key matches “${label}” (keys: ${have})` }
  }
  // Down, hold, up: what a click on the dock's key does.
  setPressed(pin.id, true)
  await sleep(holdMs)
  setPressed(pin.id, false)
  return { ok: true }
}

/**
 * Type what a Run button would: comments and blank lines skipped, placeholders
 * filled in from the debugger's thread walk and the image's symbols, after the
 * shell shows its prompt.
 */
async function typeLines(lines: readonly string[]): Promise<TestResult> {
  if (!terminal.canType()) return { ok: false, error: 'no terminal to type into' }
  const context = {
    threads: debug.getSnapshot().threads,
    symbols: debug.elfAddressSources().symbols?.objects ?? null,
  }
  const resolved = lines.filter(isCommandLine).map((line) => resolvePlaceholders(line, context))
  const error = resolved.flatMap((line) => line.errors)[0]
  if (error !== undefined) return { ok: false, error }
  await terminal.waitForPrompt(PROMPT_TIMEOUT_MS)
  const typed = await terminal.typeLines(resolved.map((line) => line.text!.trim()))
  return typed ? { ok: true } : { ok: false, error: 'the terminal went away while typing' }
}

async function replayGesture(id: string): Promise<TestResult> {
  const recordings = sampleForSeed(getDockState().seededFor)?.recordings
  if (!recordings) return { ok: false, error: 'this sample has no recordings to replay' }
  const set = RECORDING_SETS[recordings]
  if (!set.clips.some((clip) => clip.id === id)) {
    const have = set.clips.map((clip) => clip.id).join(', ')
    return { ok: false, error: `no clip “${id}” (clips: ${have})` }
  }
  const chip = i2cModel
    .chips()
    .find((c): c is SensorChip => isSensorChip(c) && c.decl.shellLabel === set.target)
  if (!chip) return { ok: false, error: `no ${set.target} on the bus to replay into` }

  startReplay(chip, set, id)
  const deadline = Date.now() + REPLAY_TIMEOUT_MS
  while (replayingClip(chip) === id) {
    if (Date.now() > deadline) return { ok: false, error: `the ${id} clip never finished` }
    await sleep(50)
  }
  return { ok: true }
}

function tourState(): TourStateSummary {
  const state = getTourState()
  const runtime = getSteps()
  const guest = debug.getSnapshot()
  const numbers = (indexes: Iterable<number>) => [...indexes].map((i) => i + 1).sort((a, b) => a - b)
  return {
    loaded: state.doc !== null,
    title: state.doc?.title ?? null,
    enabled: state.enabled,
    armed: state.armed,
    live: state.live,
    steps: (state.doc?.steps ?? []).map((step) => ({
      step: step.index + 1,
      title: step.title,
      stop: step.stop,
      repeat: step.repeat,
      await: step.await,
      do: [...step.do],
      ci: step.ci.map((action) => ({ ...action })),
    })),
    outro: Boolean(state.doc?.outro),
    current: state.current && { step: state.current.step.index + 1, paused: state.current.paused },
    waiting: state.waiting && { step: state.waiting.index + 1 },
    seen: numbers(state.seen),
    planted: numbers(runtime.filter((s) => s.planted).map((s) => s.step.index)),
    unresolved: numbers(runtime.filter((s) => s.unresolved).map((s) => s.step.index)),
    finished: state.finished,
    completed: state.completed,
    problems: [...state.problems],
    guest: { attached: guest.gdb, paused: guest.paused },
  }
}

const hooks: TestHooks = { pressKey, typeLines, replayGesture, tourState }

/** Whether a query string asks for the hooks: `?test`, `?test=1`, not `?test=0`. */
export function wantsTestHooks(search: string): boolean {
  const value = new URLSearchParams(search).get('test')
  return value !== null && !['0', 'no', 'false', 'off'].includes(value.toLowerCase())
}

/**
 * Put the hooks on `window.__zitbTest` when the URL asks for them, and only
 * then. Returns whether it did.
 */
export function installTestHooks(
  search: string = location.search,
  target: Pick<Window, '__zitbTest'> = window,
): boolean {
  if (!wantsTestHooks(search)) return false
  target.__zitbTest = hooks
  return true
}
