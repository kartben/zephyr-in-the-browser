/**
 * A/B boot and CPU benchmark of one emulator artifact set under headless Chromium.
 *
 *   node tools/ab-boot-bench.mjs --variant <dir containing qemu/> --label B \
 *        --app shell --runs 5 [--port 5183] [--out results.jsonl] [--timeout 180000]
 *
 * Copies <dir>/qemu/* into this checkout's public/qemu/ (vite indexes public/
 * at startup only, so the server is started afresh per invocation), starts
 * vite, loads ?board=qemu_cortex_m3&app=<app>&backend=qemu, and records from
 * inside the page:
 *   tModule   globalThis.Module assigned, i.e. the glue is about to load
 *   tRt       Module.onRuntimeInitialized: wasm compiled and instantiated
 *   tBanner   first "Booting Zephyr" in the terminal DOM
 *   tPrompt   first "uart:~$" (shell sample)
 *   bench     BENCH <name> run=<r> ms=<ms> cycles=<c> chk=<x> lines from the cpu_bench guest
 * A run ends at "BENCH done", or at the prompt for other apps.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = {}
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]
if (!args.variant) throw new Error('--variant <dir> is required')
const variantDir = path.resolve(args.variant)
const port = Number(args.port ?? 5183)
const app = args.app ?? 'shell'
const runs = Number(args.runs ?? 5)
const label = args.label ?? path.basename(variantDir)
const timeoutMs = Number(args.timeout ?? 180_000)
const board = args.board ?? 'qemu_cortex_m3'

// Install the variant's artifacts into public/qemu (README.md stays).
const dest = path.join(root, 'public', 'qemu')
for (const f of readdirSync(dest)) {
  if (f !== 'README.md') rmSync(path.join(dest, f), { recursive: true, force: true })
}
cpSync(path.join(variantDir, 'qemu'), dest, { recursive: true })

// AB_TRACE=1: make an Asyncify-free build report who switched coroutines. The
// stub Emscripten links in place of emscripten_fiber_swap throws a bare string;
// prefix it with a JS stack so the worker error relayed to the page names the
// wasm frames (readable when the build kept its name section).
if (process.env.AB_TRACE) {
  for (const f of readdirSync(dest)) {
    if (!f.endsWith('.js') || f.endsWith('.worker.js')) continue
    const glue = path.join(dest, f)
    const js = readFileSync(glue, 'utf8')
    const marker = 'emscripten_fiber_swap(oldFiber,newFiber){throw"'
    if (js.includes(marker)) {
      writeFileSync(glue, js.replace(marker, 'emscripten_fiber_swap(oldFiber,newFiber){throw"FIBER_SWAP_STACK "+new Error().stack+" :: '))
      console.log(`traced fiber stub in ${f}`)
    }
  }
}

// Own process group, so the whole npx/vite tree can be signalled at the end;
// killing only the parent leaves vite holding these pipes and, on Linux, the
// harness never exits (see tools/smoke-boot.mjs).
const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BROWSER: 'none' },
  detached: true,
})
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d.toString()))
vite.stderr.on('data', (d) => (viteLog += d.toString()))

async function waitForServer(ms = 60_000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`vite did not come up on ${port}:\n${viteLog}`)
}

const INIT = `
  window.__ab = { t0: performance.now(), tModule: null, tRt: null, tBanner: null, tPrompt: null,
                  bench: [], done: false, errors: [] };
  const ab = window.__ab;
  const poll = setInterval(() => {
    const M = globalThis.Module;
    if (M && typeof M === 'object' && !ab.tModule) {
      ab.tModule = performance.now();
      const prev = M.onRuntimeInitialized;
      M.onRuntimeInitialized = () => { ab.tRt = performance.now(); if (prev) prev(); };
      clearInterval(poll);
    }
  }, 1);
  const seen = new Set();
  const scan = () => {
    const rows = document.querySelector('.xterm-rows');
    if (!rows) return;
    const text = rows.innerText || rows.textContent || '';
    const now = performance.now();
    if (!ab.tBanner && /Booting Zephyr/.test(text)) ab.tBanner = now;
    if (!ab.tPrompt && /uart:~\\$/.test(text)) ab.tPrompt = now;
    for (const m of text.matchAll(/BENCH (\\w+) run=(\\d+) ms=(\\d+) cycles=(\\d+) chk=([0-9a-f]+)/g)) {
      const key = m[1] + '#' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      ab.bench.push({ name: m[1], run: Number(m[2]), ms: Number(m[3]), cycles: Number(m[4]), chk: m[5], t: now });
    }
    if (/BENCH done/.test(text)) ab.done = true;
  };
  const observe = () => {
    if (!document.documentElement) return false;
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    return true;
  };
  // Init scripts run before the document exists; attach once it does.
  if (!observe()) {
    const wait = setInterval(() => { if (observe()) clearInterval(wait); }, 5);
  }
`

const browser = await chromium.launch({ headless: true })
const results = []
try {
  await waitForServer()
  const url = `http://127.0.0.1:${port}/?board=${board}&app=${app}&backend=qemu`
  // Guard against a stale or foreign server on the port: the served wasm must be the variant's.
  const wasmName = readdirSync(path.join(variantDir, 'qemu')).find((f) => f.endsWith('.wasm'))
  const served = await fetch(`http://127.0.0.1:${port}/qemu/${wasmName}`, { method: 'HEAD' })
  const servedBytes = Number(served.headers.get('content-length'))
  const variantBytes = statSync(path.join(variantDir, 'qemu', wasmName)).size
  if (servedBytes !== variantBytes) {
    throw new Error(`port ${port} serves ${wasmName} at ${servedBytes} bytes, variant has ${variantBytes}`)
  }
  console.log(`serving ${wasmName}: ${servedBytes} bytes (${label})`)
  for (let i = 0; i < runs; i++) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await context.addInitScript(INIT)
    const page = await context.newPage()
    const errors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (e) => errors.push(String(e)))
    const started = Date.now()
    await page.goto(url)
    let state = null
    while (Date.now() - started < timeoutMs) {
      state = await page.evaluate(() => window.__ab)
      if (state.done) break
      if (state.tPrompt && app !== 'hello_world') break
      await sleep(200)
    }
    if (process.env.AB_DEBUG) {
      const dump = await page.evaluate(() => ({
        text: (document.querySelector('.xterm-rows')?.innerText ?? '<no .xterm-rows>').slice(0, 1200),
        hasModule: typeof globalThis.Module,
        ab: window.__ab,
        title: document.title,
        body: document.body?.innerText?.slice(0, 600),
      }))
      console.log('[debug]', JSON.stringify(dump, null, 1))
      await page.screenshot({ path: process.env.AB_DEBUG, fullPage: false })
    }
    await context.close()
    const r = {
      label,
      app,
      run: i,
      compileMs: state?.tRt && state?.tModule ? +(state.tRt - state.tModule).toFixed(0) : null,
      bootToBannerMs: state?.tBanner && state?.tRt ? +(state.tBanner - state.tRt).toFixed(0) : null,
      bannerToPromptMs: state?.tPrompt && state?.tBanner ? +(state.tPrompt - state.tBanner).toFixed(0) : null,
      bootToPromptMs: state?.tPrompt && state?.tRt ? +(state.tPrompt - state.tRt).toFixed(0) : null,
      bench: state?.bench?.map((b) => ({ name: b.name, ms: b.ms, cycles: b.cycles })) ?? [],
      done: !!(state?.done || state?.tPrompt),
      errors: errors.filter((e) => e.includes('FIBER_SWAP_STACK')).slice(0, 1).concat(errors.filter((e) => !e.includes('FIBER_SWAP_STACK')).slice(0, 2)),
    }
    results.push(r)
    console.log(JSON.stringify(r))
    if (args.out) appendFileSync(args.out, JSON.stringify(r) + '\n')
  }
} finally {
  await browser.close()
  try {
    process.kill(-vite.pid, 'SIGTERM')
  } catch {
    vite.kill('SIGTERM')
  }
}

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}
console.log(
  `\n${label} ${app} (${results.length} runs): median compile ${median(results.map((r) => r.compileMs))} ms, ` +
    `boot->banner ${median(results.map((r) => r.bootToBannerMs))} ms, ` +
    `boot->prompt ${median(results.map((r) => r.bootToPromptMs))} ms, ` +
    Object.entries(
      results
        .flatMap((r) => r.bench)
        .reduce((acc, b) => ((acc[b.name] ??= []).push(b.ms), acc), {}),
    )
      .map(([name, ms]) => `${name} ${median(ms)} ms`)
      .join(', '),
)
