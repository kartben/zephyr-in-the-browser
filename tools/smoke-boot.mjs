/**
 * Headless boot smoke test for the qemu-wasm artifacts in public/qemu/.
 *
 * Why this exists: an emulator artifact can be byte-plausible and completely
 * dead. Bumping tools/Dockerfile.deps from emsdk 3.1.50 to 4.0.10 produced
 * .wasm files of the right size with the right exports, linked with no
 * warnings, and passed `npm run typecheck` and the whole vitest suite. In the
 * browser they showed nothing at all: no guest output, no display, no GDB stub,
 * no error. Newer Emscripten had stopped assigning the HEAP* views onto
 * `Module`, and every bridge that reads guest memory (src/hostI2c.ts,
 * src/hostNet.ts, src/hostMonitor.ts, src/debug/browserChardev.ts,
 * src/virtio/transport.ts, src/hostDisplay.ts) checks `mod.HEAPU8` and
 * degrades to a silent no-op when it is missing.
 *
 * Nothing in CI could see that, because nothing in CI ran the emulator. So this
 * does, and asserts two separate things per artifact:
 *
 *   1. the guest boots and talks (stdout reaches the terminal), and
 *   2. the page can still read guest memory.
 *
 * (1) alone is not enough: under the broken emsdk the three TCI targets still
 * booted, because hello_world never touches a bridge. (2) is checked twice
 * over, structurally against `Module` and end to end through a sample that
 * actually drives a memory-reading bridge, where such a sample exists.
 *
 * One case per qemu-system-* artifact, since each is a separate QEMU build.
 *
 *   npx playwright install chromium     # once
 *   node tools/smoke-boot.mjs           # the whole matrix
 *   node tools/smoke-boot.mjs aarch64   # named cases only
 *   node tools/smoke-boot.mjs --board qemu_cortex_m3 --app blinky --dump
 *
 * Runs against the dev server rather than `dist/`: the artifacts under
 * public/qemu/ are the same files either way, and vite.config.ts already sets
 * the cross-origin isolation headers qemu-wasm needs.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getBoard, sampleAsset } from '../src/boards.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The matrix: one board per emulator artifact, and wherever the board has one,
 * a sample that makes the page read guest memory rather than only print.
 *
 * `expect` is matched against the terminal as it scrolls, so it has to be a
 * line the guest really emits rather than a summary of one.
 */
const CASES = [
  {
    id: 'arm',
    binary: 'qemu-system-arm',
    board: 'qemu_cortex_m3',
    // Not hello_world: nothing but the page hands out addresses on this LAN
    // (src/net/stack.ts), and to answer the DISCOVER it had to read the frame
    // out of hostNet's HEAPU8 view. So the address the guest prints here is
    // proof the bridge is alive, which hello_world could never give.
    app: 'dhcp',
    expect: /Address\[\d+\]:\s*\d+\.\d+\.\d+\.\d+/,
    expectWhy: 'a lease from the page-side DHCP server (hostNet reads guest memory)',
  },
  {
    id: 'aarch64',
    binary: 'qemu-system-aarch64',
    board: 'qemu_cortex_a53',
    app: 'accel_chart',
    expect: /Booting Zephyr OS/,
    expectWhy: 'the Zephyr banner',
    // The chart samples an ADXL345 the page models, over virtio-i2c: every
    // transaction is a hostI2c read out of HEAPU8.
    profileField: 'i2cHz',
  },
  {
    id: 'riscv32',
    binary: 'qemu-system-riscv32',
    board: 'qemu_riscv32',
    app: 'accel_chart',
    expect: /Booting Zephyr OS/,
    expectWhy: 'the Zephyr banner',
    profileField: 'i2cHz',
  },
  {
    id: 'xtensa',
    binary: 'qemu-system-xtensa',
    board: 'esp32_devkitc',
    // This board's only bridge is hostGpio, which talks through exported
    // functions rather than a HEAP view, and no sample on it drives a
    // memory-reading bridge. The Module probe below is what covers this
    // artifact: the monitor chardev reads HEAPU8 on every board.
    app: 'hello_world',
    expect: /Hello World!/,
    expectWhy: 'the sample’s one line of output',
    // TCI, and the ESP32 boot ROM before Zephyr even starts.
    bootMs: 300_000,
  },
]

const DEFAULT_BOOT_MS = 180_000
const DEFAULT_BRIDGE_MS = 90_000
const POLL_MS = 50

function usage() {
  console.log(
    `Usage: node tools/smoke-boot.mjs [case...] [options]\n\n` +
      `Cases: ${CASES.map((c) => c.id).join(', ')} (default: all)\n\n` +
      `  --board <id>     ad-hoc case: board from src/boards.ts\n` +
      `  --app <id>       ad-hoc case: sample id (default: the board's)\n` +
      `  --expect <re>    ad-hoc case: guest output to wait for\n` +
      `  --port <n>       dev server port (default 5180)\n` +
      `  --boot-ms <n>    boot timeout (default ${DEFAULT_BOOT_MS})\n` +
      `  --out <dir>      where failure transcripts and screenshots land\n` +
      `  --dump           print each guest transcript, pass or fail\n` +
      `  --headed         show the browser\n`,
  )
}

function parseArgs(argv) {
  const opts = {
    port: 5180,
    out: path.join(root, 'smoke-out'),
    dump: false,
    headed: false,
    bootMs: null,
    cases: [],
    board: null,
    app: null,
    expect: null,
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
    } else if (arg === '--port') opts.port = Number(next())
    else if (arg === '--out') opts.out = path.resolve(next())
    else if (arg === '--boot-ms') opts.bootMs = Number(next())
    else if (arg === '--board') opts.board = next()
    else if (arg === '--app') opts.app = next()
    else if (arg === '--expect') opts.expect = new RegExp(next())
    else if (arg === '--dump') opts.dump = true
    else if (arg === '--headed') opts.headed = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else opts.cases.push(arg)
  }
  return opts
}

/** Resolve the argv into the list of cases to run, ad-hoc one included. */
function selectCases(opts) {
  if (opts.board) {
    const board = getBoard(opts.board)
    if (board.id !== opts.board) throw new Error(`no board "${opts.board}" in src/boards.ts`)
    return [
      {
        id: `${board.id}/${opts.app ?? board.defaultSampleId}`,
        binary: board.qemuBinary,
        board: board.id,
        app: opts.app ?? board.defaultSampleId,
        expect: opts.expect ?? /\S/,
        expectWhy: opts.expect ? 'the requested pattern' : 'any guest output',
      },
    ]
  }
  if (!opts.cases.length) return CASES
  return opts.cases.map((id) => {
    const found = CASES.find((c) => c.id === id)
    if (!found) throw new Error(`no case "${id}" (have: ${CASES.map((c) => c.id).join(', ')})`)
    return found
  })
}

/**
 * Fail before spending a boot timeout on an artifact that is simply not there.
 * A missing file here means the release did not carry it, which is a different
 * bug from an artifact that carries it and cannot run.
 */
function preflight(cases) {
  const missing = []
  for (const testCase of cases) {
    const board = getBoard(testCase.board)
    const wanted = [
      `qemu/${board.qemuBinary}.js`,
      `qemu/${board.qemuBinary}.wasm`,
      `qemu/${sampleAsset(board, testCase.app)}`,
    ]
    for (const asset of wanted) {
      if (!existsSync(path.join(root, 'public', asset))) missing.push(`${testCase.id}: ${asset}`)
    }
  }
  return missing
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

function startVite(port) {
  const vite = spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' } },
  )
  let log = ''
  const keep = (d) => {
    log += d.toString()
  }
  vite.stdout.on('data', keep)
  vite.stderr.on('data', keep)
  return { vite, log: () => log }
}

/**
 * Fold one viewport sample into the running transcript.
 *
 * `.xterm-rows` only holds what is on screen, so a boot longer than the
 * viewport scrolls its own beginning away. Successive samples overlap; splice
 * at the longest overlap and the transcript survives the scrolling.
 */
function mergeRows(transcript, sample) {
  // xterm pads every row to the viewport width, and the trailing blanks move
  // as the cursor does. Trim them, or an unchanged screen looks like a new one.
  const rows = sample.map((row) => row.replace(/\s+$/, ''))
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  if (!rows.length) return transcript
  if (!transcript.length) return rows
  const overlap = Math.min(transcript.length, rows.length)
  for (let n = overlap; n > 0; n--) {
    let same = true
    for (let i = 0; i < n; i++) {
      if (transcript[transcript.length - n + i] !== rows[i]) {
        same = false
        break
      }
    }
    if (same) return [...transcript, ...rows.slice(n)]
  }
  return [...transcript, ...rows]
}

/**
 * What the page needs off the Emscripten Module, checked on the live instance.
 *
 * HEAPU8 is the one the bridges read guest memory through: the view the emsdk
 * bump dropped. FS and TTY are the other two `EXPORTED_RUNTIME_METHODS` the
 * backend depends on: FS to plant the guest image before main(), TTY for the
 * poll workaround that keeps a blocked guest from stalling the terminal.
 */
const MODULE_PROBE = () => {
  const mod = globalThis.Module
  if (!mod) return { loaded: false }
  const heap = mod.HEAPU8
  return {
    loaded: true,
    heapU8: ArrayBuffer.isView(heap) ? heap.byteLength : 0,
    fs: typeof mod.FS === 'object' && mod.FS !== null,
    tty: typeof mod.TTY === 'object' && mod.TTY !== null,
  }
}

async function runCase(browser, testCase, opts) {
  const board = getBoard(testCase.board)
  const bootMs = opts.bootMs ?? testCase.bootMs ?? DEFAULT_BOOT_MS
  const url =
    `http://127.0.0.1:${opts.port}/?board=${testCase.board}&app=${testCase.app}` +
    `&backend=qemu&profile=1`

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

  const result = {
    id: testCase.id,
    binary: board.qemuBinary,
    board: testCase.board,
    app: testCase.app,
    ok: false,
    failure: null,
    bootMs: null,
    bridgeField: testCase.profileField ?? null,
    bridgeValue: null,
    module: null,
    transcript: [],
    errors,
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })

    // SharedArrayBuffer, and so PROXY_TO_PTHREAD, need this. Without it the
    // emulator cannot start at all and every other symptom is downstream.
    if (!(await page.evaluate(() => globalThis.crossOriginIsolated))) {
      result.failure = 'page is not cross-origin isolated'
      return result
    }

    const start = Date.now()
    let matched = false
    let sawModule = false
    while (Date.now() - start < bootMs) {
      const sample = await page.evaluate(() => {
        const rows = document.querySelector('.xterm-rows')
        return {
          rows: rows ? rows.innerText.split('\n') : [],
          module: globalThis.Module !== undefined,
        }
      })
      result.transcript = mergeRows(result.transcript, sample.rows)
      sawModule ||= sample.module
      /*
       * Against the screen as well as the transcript. The transcript is the
       * one that can see a line that has already scrolled away, and the raw
       * screen is the one that cannot be wrong: between them, a bug in the
       * splicing above can cost a diagnostic but never fail a good build.
       */
      if (
        testCase.expect.test(sample.rows.join('\n')) ||
        testCase.expect.test(result.transcript.join('\n'))
      ) {
        matched = true
        result.bootMs = Date.now() - start
        break
      }
      /*
       * `?backend=qemu` forces the real backend, so the emulator's JS either
       * loads and sets Module or throws. Nothing else sets it, so a page still
       * without one well past the fetch is never going to boot, and waiting
       * out the full timeout only hides why.
       */
      if (!sawModule && Date.now() - start > 30_000) {
        result.failure =
          'the emulator module never loaded (no globalThis.Module after 30s). ' +
          `is public/qemu/${board.qemuBinary}.js really being served?`
        return result
      }
      await sleep(POLL_MS)
    }

    if (!matched) {
      result.failure =
        `${testCase.expectWhy} never appeared in ${(bootMs / 1000).toFixed(0)}s ` +
        `(pattern ${testCase.expect})`
      return result
    }

    // The guest talks. Now: can the page read its memory?
    result.module = await page.evaluate(MODULE_PROBE)
    if (!result.module.loaded) {
      result.failure = 'the guest printed, but globalThis.Module is gone'
      return result
    }
    const gaps = []
    if (!result.module.heapU8) gaps.push('Module.HEAPU8')
    if (!result.module.fs) gaps.push('Module.FS')
    if (!result.module.tty) gaps.push('Module.TTY')
    if (gaps.length) {
      result.failure =
        `${gaps.join(', ')} missing from the Emscripten Module. ` +
        (result.module.heapU8
          ? ''
          : 'Without HEAPU8 every bridge that reads guest memory degrades to a ' +
            'silent no-op. ') +
        'Check EXPORTED_RUNTIME_METHODS and the emsdk pin in tools/Dockerfile.deps'
      return result
    }

    if (testCase.profileField) {
      const field = testCase.profileField
      const deadline = Date.now() + DEFAULT_BRIDGE_MS
      let best = 0
      while (Date.now() < deadline) {
        const value = await page.evaluate(
          (key) => window.__zephyrProfile?.snapshot()?.[key] ?? null,
          field,
        )
        if (typeof value === 'number' && value > best) best = value
        if (best > 0) break
        await sleep(250)
      }
      result.bridgeValue = best
      if (!(best > 0)) {
        result.failure =
          `${field} stayed at 0 for ${(DEFAULT_BRIDGE_MS / 1000).toFixed(0)}s after boot: ` +
          'the guest is running but the page is not seeing its bus traffic'
        return result
      }
    }

    result.ok = true
    return result
  } catch (err) {
    result.failure = `${err}`
    return result
  } finally {
    if (!result.ok) {
      mkdirSync(opts.out, { recursive: true })
      const stem = path.join(opts.out, `smoke-${result.id.replace(/\W+/g, '-')}`)
      await page.screenshot({ path: `${stem}.png`, fullPage: false }).catch(() => {})
      writeFileSync(
        `${stem}.txt`,
        [
          `case      ${result.id}`,
          `url       ${url}`,
          `failure   ${result.failure ?? '(none)'}`,
          '',
          '--- guest transcript ---',
          ...result.transcript,
          '',
          '--- page errors ---',
          ...errors,
          '',
        ].join('\n'),
      )
      result.artifacts = stem
    }
    await context.close()
  }
}

function report(results, opts) {
  const ci = Boolean(process.env.GITHUB_ACTIONS)
  console.log('\n=== boot smoke ===')
  for (const r of results) {
    const where = `${r.binary.padEnd(21)} ${r.board}/${r.app}`
    if (r.ok) {
      const timing = [
        r.bootMs !== null ? `boot ${(r.bootMs / 1000).toFixed(1)}s` : null,
        r.bridgeValue !== null ? `${r.bridgeField} ${r.bridgeValue.toFixed(0)}` : null,
      ]
        .filter(Boolean)
        .join(', ')
      console.log(`  PASS  ${where}  (${timing})`)
    } else {
      console.log(`  FAIL  ${where}`)
      console.log(`        ${r.failure}`)
      if (r.artifacts) console.log(`        transcript + screenshot: ${r.artifacts}.{txt,png}`)
      if (ci) console.log(`::error::boot smoke: ${r.binary} (${r.board}/${r.app}): ${r.failure}`)
    }
    if (opts.dump || !r.ok) {
      const tail = r.transcript.slice(-40)
      if (tail.length) {
        console.log('        --- guest output (tail) ---')
        for (const line of tail) console.log(`        | ${line}`)
      }
      for (const err of r.errors.slice(0, 10)) console.log(`        [page] ${err}`)
    }
  }
  /*
   * Boot times belong in the run summary rather than only in the log: they are
   * how a build that got slower rather than broken shows itself, and reading
   * them run to run should not mean opening the job output every time.
   */
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    const rows = results.map((r) =>
      [
        r.ok ? '✅' : '❌',
        `\`${r.binary}\``,
        `${r.board}/${r.app}`,
        r.bootMs !== null ? `${(r.bootMs / 1000).toFixed(1)}s` : '-',
        r.bridgeValue !== null ? `${r.bridgeField} ${r.bridgeValue.toFixed(0)}` : '-',
        r.ok ? '' : r.failure,
      ].join(' | '),
    )
    appendFileSync(
      summaryFile,
      [
        '### Boot smoke',
        '',
        '| | Artifact | Board / app | Boot | Bridge | |',
        '| - | - | - | - | - | - |',
        ...rows.map((row) => `| ${row} |`),
        '',
      ].join('\n'),
    )
  }
}

// A typo in the argv is a usage mistake, not a crash: say what was wrong.
let opts
let cases
try {
  opts = parseArgs(process.argv.slice(2))
  cases = selectCases(opts)
} catch (err) {
  console.error(`${err.message}\n`)
  usage()
  process.exit(2)
}

const missing = preflight(cases)
if (missing.length) {
  console.error('Missing artifacts. Build or fetch them first:')
  for (const line of missing) console.error(`  ${line}`)
  process.exit(1)
}

const { vite, log } = startVite(opts.port)
const browser = await chromium.launch({
  headless: !opts.headed,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})

const results = []
try {
  await waitForServer(opts.port)
  for (const testCase of cases) {
    console.log(`--- ${testCase.id}: ${testCase.board}/${testCase.app} ---`)
    results.push(await runCase(browser, testCase, opts))
  }
} catch (err) {
  console.error('SMOKE ABORTED:', err)
  console.error('--- vite log (tail) ---')
  console.error(log().slice(-4000))
  process.exitCode = 1
} finally {
  await browser.close()
  vite.kill('SIGTERM')
}

if (results.length) {
  report(results, opts)
  if (results.some((r) => !r.ok)) process.exitCode = 1
}
