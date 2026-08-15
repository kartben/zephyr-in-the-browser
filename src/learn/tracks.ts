/**
 * The Learn curriculum: envnode, an environmental node with a configurable
 * alarm threshold, grown one tutorial at a time. Fifteen steps in four
 * strictly ordered tracks, all on one board.
 *
 * This file is data plus pure helpers, nothing else. The tutorial apps land
 * incrementally: a step with no `sampleId` is a locked placeholder row, and
 * filling the field in is the whole act of shipping it to the page — the
 * dialog, the progress store and the dock preset all key off the step id and
 * need no change. Ids match the tutorial sample directories so a future
 * manifest-generated track can replace this literal without migrating
 * anyone's saved progress.
 */

import { getBoard, getSample, type PanelKind } from '@/boards'
import { isGuided } from '@/tours/guided'

/** The whole series runs here; steps never switch boards. */
export const LEARN_BOARD = 'qemu_cortex_a53'

export interface LearnStep {
  /** Stable id, the persistence key. Matches the tutorial's sample directory. */
  id: string
  /** Display number, '01'..'15'. The series is strictly linear. */
  num: string
  title: string
  /** Takeaway-led: what you can do after this step. */
  takeaway: string
  /** What to poke once it is running; shown on unlocked steps without a tour. */
  tryThis?: string
  /** The sample to boot. Absent while the tutorial is still being written. */
  sampleId?: string
  /** Dock rows to show while this step runs; everything else hides. */
  dockPanels?: PanelKind[]
}

export interface LearnTrack {
  id: string
  title: string
  /** Story-led: what this stretch of the series is about. */
  intro: string
  /** Shown when every step in the track is done. */
  finished: string
  steps: LearnStep[]
}

export const TRACKS: LearnTrack[] = [
  {
    id: 'kernel-foundations',
    title: 'Kernel foundations',
    intro:
      'What Zephyr is underneath the hardware: threads, priorities, and the ' +
      'primitives that keep them honest. envnode starts here as one file, a ' +
      'fake sawtooth temperature, and a thread that reports it. No devicetree ' +
      'yet, no peripherals.',
    finished:
      'You’ve walked the whole track. envnode samples, signals and reports ' +
      'on its own; time to meet the hardware.',
    steps: [
      {
        id: '01-hello',
        num: '01',
        title: 'Hello, Zephyr',
        takeaway:
          'After this one you can boot a Zephyr app, read its boot banner, and ' +
          'tell printk from the logging API.',
        tryThis:
          'kernel version, kernel uptime, device list. The list is nearly ' +
          'empty on purpose; step 06 fills it.',
        dockPanels: [],
      },
      {
        id: '02-threads',
        num: '02',
        title: 'Threads and scheduling',
        takeaway:
          'After this one you can start a thread two ways, pick a sensible ' +
          'priority, and explain why a busy loop starves a cooperative system.',
        tryThis:
          'kernel threads before and after the starving thread is fixed; watch ' +
          'stack usage and state change.',
        dockPanels: [],
      },
      {
        id: '03-sync',
        num: '03',
        title: 'Synchronization',
        takeaway:
          'After this one you can guard shared data with a mutex, signal ' +
          'between threads with a semaphore, and spot a torn read in a log.',
        tryThis:
          'Hammer the shared struct from the shell thread to force the race, ' +
          'then watch the mutex end it.',
        dockPanels: [],
      },
      {
        id: '04-shell',
        num: '04',
        title: 'Shell and logging',
        takeaway:
          'After this one you can register your own shell command tree and turn ' +
          'a module’s debug logging on at runtime.',
        tryThis: 'envnode threshold 25000, tab completion, log enable dbg envnode.',
        dockPanels: [],
      },
      {
        id: '05-timers',
        num: '05',
        title: 'Timers, work queues, message queues',
        takeaway:
          'After this one you can move work out of interrupt context and ' +
          'decouple a producer from a consumer with a message queue.',
        tryThis: 'Stall the consumer from the shell and watch the queue fill and drop.',
        dockPanels: [],
      },
    ],
  },
  {
    id: 'describing-the-hardware',
    title: 'Describing the hardware',
    intro:
      'The board stops being an abstraction. Devicetree names the parts, ' +
      'drivers claim them, and the fake temperature generator dies the day a ' +
      'real sensor replaces it. The device dock becomes clickable here.',
    finished:
      'You’ve walked the whole track. envnode reads real parts through real ' +
      'drivers, and the sawtooth generator is gone for good.',
    steps: [
      {
        id: '06-devicetree',
        num: '06',
        title: 'Devicetree essentials',
        takeaway:
          'After this one you can read a devicetree, follow an alias to its ' +
          'node, and fetch a ready device by name instead of by address.',
        tryThis: 'device list, then print resolved devicetree properties at runtime.',
        dockPanels: [],
      },
      {
        id: '07-gpio',
        num: '07',
        title: 'GPIO',
        takeaway:
          'After this one you can drive an LED and catch a button interrupt ' +
          'without hardcoding a single pin number.',
        tryThis:
          'Click the button in the dock and watch the callback fire; drive the ' +
          'LED by hand with the gpio shell command.',
        dockPanels: ['gpio', 'keys', 'led'],
      },
      {
        id: '08-sensor',
        num: '08',
        title: 'Sensor API',
        takeaway:
          'After this one you can read a real I2C sensor through the driver API ' +
          'and never touch a register.',
        tryThis:
          'sensor get, i2c scan, then drag the temperature slider and watch the ' +
          'threshold trigger fire. Open the I2C bus row and watch the driver’s ' +
          'register reads cross the wire.',
        dockPanels: ['sensor', 'i2c'],
      },
      {
        id: '09-kconfig',
        num: '09',
        title: 'Kconfig and overlays',
        takeaway:
          'After this one you can add your own Kconfig option, layer ' +
          'configuration fragments, and say which one wins.',
        tryThis: 'Two config variants of the same app, switched and compared.',
        dockPanels: ['sensor', 'i2c'],
      },
    ],
  },
  {
    id: 'turning-it-into-a-product',
    title: 'Turning it into a product',
    intro:
      'A demo becomes a device: settings that survive reboots, readings ' +
      'published over the network, a shell fit for the field, and power ' +
      'management that does not fight the drivers.',
    finished:
      'You’ve walked the whole track. envnode now reads like a product, not a demo.',
    steps: [
      {
        id: '10-settings',
        num: '10',
        title: 'Settings and NVS',
        takeaway:
          'After this one you can persist a setting to flash and trust it ' +
          'across reboots.',
        tryThis: 'Set a threshold, hit Reset, confirm it survived. settings shell.',
        dockPanels: ['spi', 'disk'],
      },
      {
        id: '11-net',
        num: '11',
        title: 'Networking',
        takeaway:
          'After this one you can open a socket, publish over MQTT, and watch ' +
          'your packets on the wire.',
        tryThis: 'net iface, net ping, net sockets, and the packet capture in Network.',
        dockPanels: ['net'],
      },
      {
        id: '12-shell-deep',
        num: '12',
        title: 'Shell and logging, deep dive',
        takeaway:
          'After this one you can build completion for your own commands, run ' +
          'the shell over the network, and survive a log buffer overflow.',
        tryThis:
          'Drive one session over two backends at once; overflow the log buffer ' +
          'on purpose.',
        dockPanels: ['net'],
      },
      {
        id: '13-pm',
        num: '13',
        title: 'Power management',
        takeaway:
          'After this one you can suspend a device, resume it around each use, ' +
          'and find the driver that never lets go.',
        tryThis: 'pm shell state dump, with a log line per suspend and resume.',
        dockPanels: [],
      },
    ],
  },
  {
    id: 'doing-it-properly',
    title: 'Doing it properly',
    intro:
      'The habits that keep envnode alive after the tutorial ends: tests that ' +
      'fake the hardware, and the instruments that explain a crash instead of ' +
      'letting you guess.',
    finished:
      'You’ve walked the whole track, and the whole series with it. envnode ' +
      'is built, tested and observable; the rest is yours.',
    steps: [
      {
        id: '14-testing',
        num: '14',
        title: 'Testing with ztest and twister',
        takeaway:
          'After this one you can factor logic out of main.c, put a test suite ' +
          'around it, and fake a sensor from the test.',
        tryThis: 'A pass and fail run of the suite, rendered as a run, not a build.',
        dockPanels: [],
      },
      {
        id: '15-observability',
        num: '15',
        title: 'Observability and debugging',
        takeaway:
          'After this one you can read a fatal error dump, follow a kernel ' +
          'trace, and corner a lock-order deadlock.',
        tryThis:
          'Trigger both planted bugs from the shell; diagnose from the trace ' +
          'and the stack dump.',
        dockPanels: ['trace', 'debug'],
      },
    ],
  },
]

/** A step is startable once its tutorial app exists. */
export function isUnlocked(step: LearnStep): boolean {
  return step.sampleId !== undefined
}

/** True when the step's sample carries a guided tour. */
export function isGuidedStep(step: LearnStep): boolean {
  if (step.sampleId === undefined) return false
  const board = getBoard(LEARN_BOARD)
  if (!board.samples.some((sample) => sample.id === step.sampleId)) return false
  return isGuided(getSample(board, step.sampleId))
}

export interface TrackProgress {
  /** Done steps in this track (only unlocked steps can be marked). */
  done: number
  /** Every step, locked or not — the track's honest length. */
  total: number
  /** Steps that can be started today. */
  unlocked: number
}

export function trackProgress(track: LearnTrack, done: ReadonlySet<string>): TrackProgress {
  let doneCount = 0
  let unlocked = 0
  for (const step of track.steps) {
    if (isUnlocked(step)) unlocked += 1
    if (done.has(step.id)) doneCount += 1
  }
  return { done: doneCount, total: track.steps.length, unlocked }
}

/**
 * The header line for a track. A track with nothing startable says so instead
 * of dangling a "0 of 5" nobody can act on.
 */
export function progressLabel(progress: TrackProgress): string {
  if (progress.unlocked === 0) return 'still being written'
  if (progress.done === 0) return 'not started'
  if (progress.done >= progress.total) return `all ${progress.total} done`
  return `${progress.done} of ${progress.total} done`
}

/** The step to resume: first unlocked step not yet marked done. */
export function nextStep(track: LearnTrack, done: ReadonlySet<string>): LearnStep | null {
  return track.steps.find((step) => isUnlocked(step) && !done.has(step.id)) ?? null
}

/**
 * Which track the dialog should open on: the first one underway, else the
 * first untouched one with anything startable, else null (nothing to suggest —
 * all locked, or all done).
 */
export function suggestNextTrack(
  tracks: LearnTrack[],
  done: ReadonlySet<string>,
): LearnTrack | null {
  for (const track of tracks) {
    const p = trackProgress(track, done)
    if (p.done > 0 && p.done < p.total) return track
  }
  for (const track of tracks) {
    const p = trackProgress(track, done)
    if (p.done === 0 && p.unlocked > 0) return track
  }
  return null
}

/** Find a step by id across all tracks. */
export function findStep(
  stepId: string,
): { track: LearnTrack; step: LearnStep } | null {
  for (const track of TRACKS) {
    const step = track.steps.find((s) => s.id === stepId)
    if (step) return { track, step }
  }
  return null
}

/** The step that follows another within its track, locked or not. */
export function stepAfter(stepId: string): LearnStep | null {
  const found = findStep(stepId)
  if (!found) return null
  const index = found.track.steps.indexOf(found.step)
  return found.track.steps[index + 1] ?? null
}

/** Whole-series count for the top-bar badge. */
export function seriesProgress(done: ReadonlySet<string>): { done: number; total: number } {
  let doneCount = 0
  let total = 0
  for (const track of TRACKS) {
    total += track.steps.length
    for (const step of track.steps) if (done.has(step.id)) doneCount += 1
  }
  return { done: doneCount, total }
}

/** True when this step is what the current selection is running. */
export function stepMatchesSelection(
  step: LearnStep,
  boardId: string,
  sampleId: string,
): boolean {
  return step.sampleId !== undefined && boardId === LEARN_BOARD && sampleId === step.sampleId
}
