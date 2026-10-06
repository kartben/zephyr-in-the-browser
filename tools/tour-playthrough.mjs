/**
 * Headless playthrough of every guided tour, on the real emulator.
 *
 * Why this exists: `npm test` proves a tour parses, and the anchor gate proves
 * each `at:` resolves against the shipped ELF. Neither proves the guest gets
 * there. A step can resolve and never fire (its line runs before the step's
 * turn comes round, or only on a path the sample does not take), wait on a
 * reader who has nothing to do, or come up as a card that does not render.
 * Only playing the tour can see that, so this does, the way a reader would:
 *
 *   1. open ?board=<board>&app=<app>&backend=qemu&test=1, which boots the
 *      sample with its tour and installs window.__zitbTest
 *      (src/lib/testHooks.ts);
 *   2. wait for each step's card, [data-tour-step="<n>"], in order, pressing
 *      Start on the intro card ([data-tour-intro]) first when the tour has one;
 *   3. on the way to a step that needs the reader, do their part: type the
 *      step's `do:` lines, then run its `ci:` actions (`press sw0`, ...);
 *   4. click Continue (or Got it), allowing 30 s per step;
 *   5. fail on a step that never comes, on any tour problem, or on a failed
 *      `check:` banner ([data-tour-check="fail"]).
 *
 *   npx playwright install chromium          # once
 *   node tools/tour-playthrough.mjs          # every tour, on qemu_cortex_a53
 *   node tools/tour-playthrough.mjs blinky   # named tours only
 *
 * Runs against the dev server, like tools/smoke-boot.mjs, whose server and
 * browser bootstrap this follows. In a git worktree the dev server serves the
 * main checkout's public/qemu/, so the images there are enough.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getBoard, sampleAsset } from '../src/boards.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOURS_DIR = path.join(root, 'tours')

const DEFAULT_BOARD = 'qemu_cortex_a53'
const DEFAULT_PORT = 5181
/** Page load, emulator boot and gdb attach, up to the tour planting its first breakpoint. */
const DEFAULT_BOOT_MS = 180_000
/** From one card going (or the tour arming) to the next card showing. */
const DEFAULT_STEP_MS = 30_000
const POLL_MS = 100

/** The button that dismisses a step card, whichever way it is labelled. */
const NEXT_BUTTON = /^(Continue|Got it)$/

function usage() {
  console.log(
    `Usage: node tools/tour-playthrough.mjs [tour...] [options]\n\n` +
      `Tours: ids from tours/*.tour.md (default: all)\n\n` +
      `  --board <id>     board from src/boards.ts (default ${DEFAULT_BOARD})\n` +
      `  --port <n>       dev server port (default ${DEFAULT_PORT})\n` +
      `  --boot-ms <n>    budget until the tour arms (default ${DEFAULT_BOOT_MS})\n` +
      `  --step-ms <n>    budget per step (default ${DEFAULT_STEP_MS})\n` +
      `  --out <dir>      where failure transcripts and screenshots land\n` +
      `  --headed         show the browser\n`,
  )
}

function parseArgs(argv) {
  const opts = {
    board: DEFAULT_BOARD,
    port: DEFAULT_PORT,
    bootMs: DEFAULT_BOOT_MS,
    stepMs: DEFAULT_STEP_MS,
    out: path.join(root, 'tour-out'),
    headed: false,
    tours: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg === '--board') opts.board = next()
    else if (arg === '--port') opts.port = Number(next())
    else if (arg === '--boot-ms') opts.bootMs = Number(next())
    else if (arg === '--step-ms') opts.stepMs = Number(next())
    else if (arg === '--out') opts.out = path.resolve(next())
    else if (arg === '--headed') opts.headed = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else opts.tours.push(arg)
  }
  return opts
}

/** The front matter's `tour:`, which is what the page reports as the tour's title. */
function frontMatterTitle(text) {
  const front = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))
  const line = front && /^tour:\s*(.+)$/m.exec(front[1])
  return line ? line[1].trim().replace(/^(["'])(.*)\1$/, '$2') : null
}

/**
 * Every tour in tours/. A tour id is its file name, and the app it runs on is
 * the id up to the first dot: `basic_button`, or `basic_button.msgq` for a
 * second tour of the same sample.
 */
function discoverTours() {
  return readdirSync(TOURS_DIR)
    .filter((file) => file.endsWith('.tour.md'))
    .sort()
    .map((file) => {
      const id = file.replace(/\.tour\.md$/, '')
      return {
        id,
        app: id.split('.')[0],
        title: frontMatterTitle(readFileSync(path.join(TOURS_DIR, file), 'utf8')),
      }
    })
}

function selectTours(opts) {
  const all = discoverTours()
  if (!opts.tours.length) return all
  return opts.tours.map((id) => {
    const found = all.find((tour) => tour.id === id)
    if (!found) throw new Error(`no tour "${id}" (have: ${all.map((t) => t.id).join(', ')})`)
    return found
  })
}

async function waitForServer(port, timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`vite dev server did not come up on :${port}`)
}

/** Same as tools/smoke-boot.mjs: its own process group, so stopping it stops vite too. */
function startVite(port) {
  const vite = spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
      detached: true,
    },
  )
  let log = ''
  const keep = (d) => {
    log += d.toString()
  }
  vite.stdout.on('data', keep)
  vite.stderr.on('data', keep)
  return { vite, log: () => log }
}

function stopVite(vite) {
  try {
    process.kill(-vite.pid, 'SIGTERM')
  } catch {
    vite.kill('SIGTERM')
  }
}

/**
 * Ask the server for what the page will fetch, rather than looking in
 * public/qemu/: in a worktree the dev server answers from the main checkout.
 * Accept anything but HTML, so the SPA fallback cannot pass for a file.
 */
async function preflight(port, board, apps) {
  const wanted = [
    `qemu/${board.qemuBinary}.js`,
    `qemu/${board.qemuBinary}.wasm`,
    ...apps.map((app) => `qemu/${sampleAsset(board, app)}`),
  ]
  const missing = []
  for (const asset of wanted) {
    const res = await fetch(`http://127.0.0.1:${port}/${asset}`, {
      method: 'HEAD',
      headers: { accept: 'application/octet-stream' },
    }).catch(() => null)
    if (!res?.ok || (res.headers.get('content-type') ?? '').includes('text/html')) missing.push(asset)
  }
  return missing
}

const secs = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`)

class TourFailure extends Error {}

/** Poll `fn` until it returns something truthy, or null at the deadline. */
async function until(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(POLL_MS)
  }
}

/**
 * The tour card on screen, read from its data-tour-* attributes. The page shows
 * one at a time: a step card, a your-turn card, or the completion card.
 */
const CARD_PROBE = () => {
  const el = document.querySelector('[data-tour-step], [data-tour-complete]')
  if (!el) return null
  const check = el.querySelector('[data-tour-check]')
  return {
    step: el.hasAttribute('data-tour-step') ? Number(el.getAttribute('data-tour-step')) : null,
    waiting: el.hasAttribute('data-tour-waiting'),
    paused: el.hasAttribute('data-tour-paused'),
    complete: el.hasAttribute('data-tour-complete'),
    check: check?.getAttribute('data-tour-check') ?? null,
    checkText: check?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
  }
}

function problemsOf(state) {
  return state.problems.length
    ? `the tour has problems: ${state.problems.join('; ')}`
    : null
}

/** What the page was doing when a step did not come, for the failure line. */
function describeWait(state, step) {
  const n = step.step
  const parts = []
  if (state.waiting) parts.push(`the your-turn card for step ${state.waiting.step} was up`)
  else if (state.current) parts.push(`step ${state.current.step}'s card was up`)
  else if (state.planted.includes(n)) parts.push(`step ${n} was planted`)
  else parts.push(`step ${n} was not planted (planted: ${state.planted.join(', ') || 'none'})`)
  parts.push(state.guest.paused ? 'the guest was paused' : 'the guest was running')
  // The usual cause: the reader has something to do here, and CI was not told.
  if (step.ci.length === 0 && step.do.length === 0) {
    parts.push(
      step.await
        ? 'the step waits on the reader but has no `ci:` actions'
        : 'if the reader has to act to get here, give the step a `ci:`',
    )
  }
  return parts.join('; ')
}

/** The reader's part on the way to a step: its `do:` lines, then its `ci:` actions. */
async function act(page, step) {
  const where = `step ${step.step} (“${step.title}”)`
  const done = []
  const check = (result, what) => {
    if (!result?.ok) throw new TourFailure(`${where}: could not ${what}: ${result?.error ?? 'no test hooks'}`)
  }
  if (step.await && step.do.length) {
    check(await page.evaluate((lines) => window.__zitbTest?.typeLines(lines), step.do), 'type its `do:` lines')
    done.push(`typed ${step.do.length} do: line${step.do.length > 1 ? 's' : ''}`)
  }
  for (const action of step.ci) {
    if (action.kind === 'press') {
      check(await page.evaluate((key) => window.__zitbTest?.pressKey(key), action.key), `press ${action.key}`)
      done.push(`press ${action.key}`)
    } else if (action.kind === 'type') {
      check(await page.evaluate((line) => window.__zitbTest?.typeLines([line]), action.line), `type “${action.line}”`)
      done.push(`type ${action.line}`)
    } else if (action.kind === 'wait') {
      await sleep(action.ms)
      done.push(`wait ${action.ms}ms`)
    }
  }
  return done
}

/**
 * Bring one step's card up and dismiss it. Returns what was done to get there.
 *
 * The clock starts when the previous card went. A step with `await:` shows its
 * your-turn card first; one without can still need the reader (basic_button's
 * press of SW0), and then its `ci:` runs once its breakpoint is planted and the
 * guest is running, which is the moment a reader would act.
 */
async function playStep(page, step, info, opts, reloaded) {
  const n = step.step
  const where = `step ${n} (“${step.title}”)`
  const deadline = Date.now() + opts.stepMs
  let done = null
  for (;;) {
    // A reload restarts the tour from step 1, which would read as a step out of order.
    if (reloaded()) throw new TourFailure(`${where}: the page reloaded during the tour`)
    // A tour with an intro opens on its own card, whose Start comes alive
    // with the first stop; the step cards are behind it until then.
    const start = page.locator('[data-tour-intro] [data-tour-start]:not([disabled])')
    if (await start.count()) await start.click({ timeout: 10_000 })

    const card = await page.evaluate(CARD_PROBE)
    const last = await page.evaluate(() => window.__zitbTest.tourState())
    const problems = problemsOf(last)
    if (problems) throw new TourFailure(`${where}: ${problems}`)

    if (card && !card.waiting && !card.complete && card.step !== null) {
      if (card.step === n) break
      // Only a `repeat: yes` step comes round again; anything else is out of order.
      if (!info.steps[card.step - 1]?.repeat) {
        throw new TourFailure(
          `${where}: step ${card.step} came up first, out of order ` +
            `(planted: ${last.planted.join(', ') || 'none'})`,
        )
      }
      const again = `[data-tour-step="${card.step}"]:not([data-tour-waiting])`
      await page.locator(again).getByRole('button', { name: NEXT_BUTTON }).click({ timeout: 10_000 })
      await page.waitForSelector(again, { state: 'detached', timeout: 10_000 })
    }

    const needsHands = (step.await && step.do.length > 0) || step.ci.length > 0
    if (done === null && needsHands && !last.guest.paused) {
      const yourTurn = card?.waiting && card.step === n
      const runningTowards = !card && last.current === null && last.planted.includes(n)
      if (yourTurn || (!step.await && runningTowards)) done = await act(page, step)
    }

    if (Date.now() >= deadline) {
      throw new TourFailure(`${where}: no card in ${secs(opts.stepMs)}; ${describeWait(last, step)}`)
    }
    await sleep(POLL_MS)
  }

  const card = await page.evaluate(CARD_PROBE)
  if (card?.check === 'fail') throw new TourFailure(`${where}: check failed: ${card.checkText}`)
  const notes = card?.check === 'unread' ? [`${where}: check values could not be read`] : []

  const self = `[data-tour-step="${n}"]:not([data-tour-waiting])`
  await page.locator(self).getByRole('button', { name: NEXT_BUTTON }).click({ timeout: 10_000 })
  await page.waitForSelector(self, { state: 'detached', timeout: 10_000 })
  return { done: done ?? [], paused: card?.paused ?? false, notes }
}

async function runTour(browser, tour, opts) {
  const board = getBoard(opts.board)
  const params = new URLSearchParams({ board: board.id, app: tour.app, backend: 'qemu', test: '1' })
  // A second tour of a sample is picked by ?tour=; the default one by the app alone.
  if (tour.id !== tour.app) params.set('tour', tour.id)
  const url = `http://127.0.0.1:${opts.port}/?${params}`

  const result = {
    id: tour.id,
    app: tour.app,
    status: 'fail',
    reached: 0,
    total: 0,
    bootMs: null,
    stepsMs: null,
    failure: null,
    notes: [],
    state: null,
    log: [],
  }
  if (!board.samples.some((sample) => sample.id === tour.app)) {
    result.status = 'skip'
    result.failure = `${board.id} has no ${tour.app}`
    return result
  }

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  // The store's own warnings say why a tour did not arm; keep them for the report.
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning' || msg.text().startsWith('[tour]')) {
      result.log.push(`${msg.type()}: ${msg.text()}`)
    }
  })
  page.on('pageerror', (err) => result.log.push(`pageerror: ${err.message}`))
  let navigations = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++
  })
  const state = () => page.evaluate(() => window.__zitbTest?.tourState() ?? null)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    if (!(await page.evaluate(() => globalThis.crossOriginIsolated))) {
      throw new TourFailure('page is not cross-origin isolated')
    }
    const start = Date.now()
    let info = await until(async () => {
      const s = await state()
      return s?.loaded ? s : null
    }, 60_000)
    if (!info) {
      throw new TourFailure(
        (await page.evaluate(() => Boolean(window.__zitbTest)))
          ? `no tour loaded for ${tour.app}`
          : 'no window.__zitbTest: the page did not install its ?test=1 hooks',
      )
    }
    result.total = info.steps.length
    result.state = info
    // ?tour= picks a sample's other tours; landing on another one is a broken link.
    if (tour.id !== tour.app && info.title !== tour.title) {
      throw new TourFailure(`?tour=${tour.id} opened “${info.title}” instead`)
    }

    info = await until(async () => {
      const s = await state()
      return s && (s.armed || s.current || s.waiting || s.finished || s.problems.length) ? s : null
    }, opts.bootMs)
    if (!info) {
      result.state = await state()
      throw new TourFailure(
        `the tour never armed in ${secs(opts.bootMs)}: ` +
          (result.state?.guest.attached ? 'no step resolved' : 'gdb never attached'),
      )
    }
    result.state = info
    /*
     * When QEMU cannot start, the page falls back to the mock backend, which
     * replays the tour on a timer with no guest under it. Its cards would pass
     * for the real ones, so insist on a tour a gdb session is driving.
     */
    if (!info.live) {
      throw new TourFailure('the tour is replaying on the mock backend: the emulator did not start')
    }
    const problems = problemsOf(info)
    if (problems) throw new TourFailure(problems)
    result.bootMs = Date.now() - start
    console.log(`  armed in ${secs(result.bootMs)}`)

    const armedAt = navigations
    const reloaded = () => navigations > armedAt
    const stepsStart = Date.now()
    for (const step of info.steps) {
      const stepStart = Date.now()
      const played = await playStep(page, step, info, opts, reloaded)
      result.reached = step.step
      result.notes.push(...played.notes)
      const how = [played.paused ? 'paused' : null, ...played.done].filter(Boolean).join(', ')
      console.log(
        `  step ${step.step}/${info.steps.length}  ${secs(Date.now() - stepStart).padStart(6)}  ` +
          `${step.title}${how ? `  (${how})` : ''}`,
      )
    }

    // The last Continue ends the tour; one with an outro ends on its completion card.
    const end = await until(async () => {
      const s = await state()
      return s?.finished ? s : null
    }, opts.stepMs)
    result.state = end ?? (await state())
    if (!end?.completed) throw new TourFailure('every step came up, but the tour did not complete')
    if (end.outro) {
      const shown = await page
        .waitForSelector('[data-tour-complete]', { timeout: opts.stepMs })
        .catch(() => null)
      if (!shown) throw new TourFailure(`no completion card in ${secs(opts.stepMs)}`)
      console.log('  completion card up')
    }
    result.stepsMs = Date.now() - stepsStart
    result.status = 'pass'
    return result
  } catch (err) {
    result.failure =
      err instanceof TourFailure ? err.message : String(err?.message ?? err).split('\n')[0]
    return result
  } finally {
    if (result.status === 'fail') await saveArtifacts(page, result, url, opts)
    await context.close()
  }
}

/** A screenshot, the terminal as it stood, and the tour state, for a failure on a runner. */
async function saveArtifacts(page, result, url, opts) {
  mkdirSync(opts.out, { recursive: true })
  const stem = path.join(opts.out, `tour-${result.id.replace(/\W+/g, '-')}`)
  await page.screenshot({ path: `${stem}.png` }).catch(() => {})
  const terminal = await page
    .evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '')
    .catch(() => '')
  const state = await page
    .evaluate(() => window.__zitbTest?.tourState() ?? null)
    .catch(() => null)
  writeFileSync(
    `${stem}.txt`,
    [
      `tour      ${result.id}`,
      `url       ${url}`,
      `failure   ${result.failure ?? '(none)'}`,
      '',
      '--- tour state ---',
      JSON.stringify(state ?? result.state, null, 2),
      '',
      '--- terminal ---',
      ...terminal.split('\n').map((line) => line.replace(/\s+$/, '')),
      '',
      '--- page log ---',
      ...result.log,
      '',
    ].join('\n'),
  )
  result.artifacts = stem
}

function report(results, opts) {
  const ci = Boolean(process.env.GITHUB_ACTIONS)
  const width = Math.max(...results.map((r) => r.id.length))
  console.log(`\n=== tour playthrough (${opts.board}) ===`)
  for (const r of results) {
    const id = r.id.padEnd(width)
    const steps = `${r.reached}/${r.total} steps`.padEnd(11)
    if (r.status === 'pass') {
      console.log(`  PASS  ${id}  ${steps}  boot ${secs(r.bootMs)}, steps ${secs(r.stepsMs)}`)
    } else if (r.status === 'skip') {
      console.log(`  SKIP  ${id}  ${r.failure}`)
      if (ci) console.log(`::warning::tour playthrough: ${r.id} skipped: ${r.failure}`)
    } else {
      console.log(`  FAIL  ${id}  ${steps}  ${r.failure}`)
      if (r.artifacts) console.log(`        transcript + screenshot: ${r.artifacts}.{txt,png}`)
      for (const line of r.log.slice(-10)) console.log(`        [page] ${line}`)
      if (ci) console.log(`::error::tour playthrough: ${r.id}: ${r.failure}`)
    }
    for (const note of r.notes) console.log(`        note: ${note}`)
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    const mark = { pass: '✅', skip: '⏭️', fail: '❌' }
    // An anchor's `a | b` in a failure would otherwise split the table's row.
    const cell = (text) => String(text).replaceAll('|', '\\|')
    appendFileSync(
      summaryFile,
      [
        `### Tour playthrough (${opts.board})`,
        '',
        '| | Tour | Steps | Boot | Steps took | |',
        '| - | - | - | - | - | - |',
        ...results.map(
          (r) =>
            `| ${mark[r.status]} | ${r.id} | ${r.reached}/${r.total} | ${secs(r.bootMs)} | ` +
            `${secs(r.stepsMs)} | ${r.status === 'pass' ? '' : cell(r.failure)} |`,
        ),
        '',
      ].join('\n'),
    )
  }
}

// A typo in the argv is a usage mistake, not a crash: say what was wrong.
let opts
let tours
let board
try {
  opts = parseArgs(process.argv.slice(2))
  board = getBoard(opts.board)
  if (board.id !== opts.board) throw new Error(`no board "${opts.board}" in src/boards.ts`)
  tours = selectTours(opts)
} catch (err) {
  console.error(`${err.message}\n`)
  usage()
  process.exit(2)
}

const { vite, log } = startVite(opts.port)
// Ctrl+C would otherwise leave vite holding the port for the next run.
process.on('SIGINT', () => {
  stopVite(vite)
  process.exit(130)
})
const browser = await chromium.launch({
  headless: !opts.headed,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

const results = []
try {
  await waitForServer(opts.port)
  const apps = [...new Set(tours.map((t) => t.app))].filter((app) =>
    board.samples.some((sample) => sample.id === app),
  )
  const missing = await preflight(opts.port, board, apps)
  if (missing.length) {
    console.error('Missing artifacts. Build or fetch them first:')
    for (const asset of missing) console.error(`  ${asset}`)
    process.exitCode = 1
  } else {
    /*
     * One throwaway load first. A dev server that discovers a dependency on
     * the first page it serves optimizes it and reloads that page, which mid
     * tour would look like a step that never came.
     */
    const warm = await browser.newPage()
    await warm.goto(`http://127.0.0.1:${opts.port}/?board=${board.id}&backend=mock`, { waitUntil: 'load' })
    await sleep(1000)
    await warm.close()

    for (const tour of tours) {
      console.log(`--- ${tour.id}: ${board.id}/${tour.app} ---`)
      results.push(await runTour(browser, tour, opts))
    }
  }
} catch (err) {
  console.error('PLAYTHROUGH ABORTED:', err)
  console.error('--- vite log (tail) ---')
  console.error(log().slice(-4000))
  process.exitCode = 1
} finally {
  await browser.close()
  stopVite(vite)
}

if (results.length) {
  report(results, opts)
  if (results.some((r) => r.status === 'fail')) process.exitCode = 1
}

// Everything is reported; if some handle still keeps the event loop alive, do
// not let it hold a CI step open. Unref'd, so a clean exit is not delayed.
setTimeout(() => process.exit(process.exitCode ?? 0), 5_000).unref()
