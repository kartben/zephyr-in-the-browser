/**
 * Boot the Cortex-A53 accelerometer chart under Chrome and sample
 * window.__zephyrProfile for ~10 seconds once the display is live.
 *
 *   npx playwright install chromium   # once
 *   node tools/profile-accel.mjs
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5173
const APP_URL =
  `http://127.0.0.1:${PORT}/?board=qemu_cortex_a53&app=accel_chart&backend=qemu&profile=1`

async function waitForServer(timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('vite dev server did not come up')
}

const vite = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BROWSER: 'none' },
})
let viteLog = ''
vite.stdout.on('data', (d) => {
  viteLog += d.toString()
})
vite.stderr.on('data', (d) => {
  viteLog += d.toString()
})

const browser = await chromium.launch({
  headless: true,
})

try {
  await waitForServer()
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[page]', msg.text())
  })
  page.on('pageerror', (err) => console.error('[pageerror]', err.message))

  console.log('navigating', APP_URL)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })

  // Cross-origin isolation is required for SharedArrayBuffer / qemu-wasm.
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated)
  console.log('crossOriginIsolated:', isolated)
  if (!isolated) throw new Error('page is not cross-origin isolated')

  // Wait until the display canvas is painted by the worker.
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas')
      return canvas?.dataset.renderer === 'worker-webgl2' || canvas?.dataset.renderer === 'webgl2'
    },
    { timeout: 180_000 },
  )
  console.log('display renderer ready')

  // Collect ~10 s of rolled windows (profiler rolls every 250 ms).
  const samples = []
  const start = Date.now()
  while (Date.now() - start < 10_000) {
    await sleep(500)
    const snap = await page.evaluate(() => window.__zephyrProfile?.snapshot() ?? null)
    if (snap && snap.display.available) samples.push(snap)
    process.stdout.write(
      `  t=${((Date.now() - start) / 1000).toFixed(1)}s guest=${snap?.guestFps?.toFixed?.(1) ?? '-'} ` +
        `up=${snap?.uploadFps?.toFixed?.(1) ?? '-'} i2c=${snap?.i2cHz?.toFixed?.(0) ?? '-'} ` +
        `mips=${snap?.mips?.toFixed?.(1) ?? '-'}\n`,
    )
  }

  const avg = (key) =>
    samples.reduce((s, x) => s + x[key], 0) / Math.max(1, samples.length)

  console.log('\n=== accel_chart profile (' + samples.length + ' samples) ===')
  console.log(
    JSON.stringify(
      {
        guestFps: +avg('guestFps').toFixed(2),
        uploadFps: +avg('uploadFps').toFixed(2),
        digestMs: +avg('digestMs').toFixed(3),
        drawMs: +avg('drawMs').toFixed(3),
        i2cHz: +avg('i2cHz').toFixed(1),
        mips: +avg('mips').toFixed(1),
        notes: [...new Set(samples.flatMap((s) => s.notes))],
        last: samples.at(-1),
      },
      null,
      2,
    ),
  )
} catch (err) {
  console.error('PROFILE FAILED:', err)
  console.error('--- vite log (tail) ---')
  console.error(viteLog.slice(-4000))
  process.exitCode = 1
} finally {
  await browser.close()
  vite.kill('SIGTERM')
}
