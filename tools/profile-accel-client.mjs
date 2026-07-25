/**
 * Profile against an already-running vite on :5173.
 * Drives the ADXL channels with a sine so the chart actually paints new
 * pixels — a flat trace produces identical frames and reads as guestFps=0
 * even when the guest is healthy.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173
 *   node tools/profile-accel-client.mjs
 */
import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'

const APP_URL =
  'http://127.0.0.1:5173/?board=qemu_cortex_a53&app=accel_chart&backend=qemu&profile=1'

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[page]', msg.text())
  })
  page.on('pageerror', (err) => console.error('[pageerror]', err.message))

  console.log('navigating', APP_URL)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })

  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated)
  console.log('crossOriginIsolated:', isolated)
  if (!isolated) throw new Error('page is not cross-origin isolated')

  console.log('waiting for display renderer…')
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas')
      return canvas?.dataset.renderer === 'worker-webgl2' || canvas?.dataset.renderer === 'webgl2'
    },
    { timeout: 180_000 },
  )
  const renderer = await page.evaluate(() => document.querySelector('canvas')?.dataset.renderer)
  console.log('display renderer ready:', renderer)

  // Expose the ADXL chip handle, then oscillate it so every sample changes pixels.
  const hooked = await page.evaluate(async () => {
    const mod = await import('/src/virtio/index.ts')
    const chips = mod.i2cModel.chips()
    const adxl = chips.find((c) => c.address === 0x53)
    if (!adxl || typeof adxl.setChannel !== 'function') return false
    globalThis.__zephyrAdxl = adxl
    const start = performance.now()
    const tick = () => {
      const t = (performance.now() - start) / 1000
      const chip = globalThis.__zephyrAdxl
      if (chip) {
        chip.setChannel('accel_x', Math.sin(t * 2.1) * 8)
        chip.setChannel('accel_y', Math.cos(t * 1.7) * 6)
        chip.setChannel('accel_z', 9.8 + Math.sin(t * 0.9) * 2)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
  })
  console.log('adxl hooked:', hooked)

  await sleep(2000)

  const samples = []
  const start = Date.now()
  while (Date.now() - start < 12_000) {
    await sleep(500)
    const snap = await page.evaluate(() => window.__zephyrProfile?.snapshot() ?? null)
    if (snap && snap.display.available) samples.push(snap)
    console.log(
      `  t=${((Date.now() - start) / 1000).toFixed(1)}s guest=${snap?.guestFps?.toFixed?.(1) ?? '-'} ` +
        `up=${snap?.uploadFps?.toFixed?.(1) ?? '-'} i2c=${snap?.i2cHz?.toFixed?.(0) ?? '-'} ` +
        `mips=${snap?.mips?.toFixed?.(1) ?? '-'} digest=${snap?.digestMs?.toFixed?.(2) ?? '-'} ` +
        `draw=${snap?.drawMs?.toFixed?.(2) ?? '-'} ${snap?.display?.width ?? '?'}x${snap?.display?.height ?? '?'} ` +
        `notes=${(snap?.notes ?? []).join(',')}`,
    )
  }

  const avg = (key) => samples.reduce((s, x) => s + x[key], 0) / Math.max(1, samples.length)
  const steady = samples.slice(Math.floor(samples.length / 3))
  const avgSteady = (key) => steady.reduce((s, x) => s + x[key], 0) / Math.max(1, steady.length)

  console.log('\n=== accel_chart profile ===')
  console.log(
    JSON.stringify(
      {
        samples: samples.length,
        all: {
          guestFps: +avg('guestFps').toFixed(2),
          uploadFps: +avg('uploadFps').toFixed(2),
          digestMs: +avg('digestMs').toFixed(3),
          drawMs: +avg('drawMs').toFixed(3),
          i2cHz: +avg('i2cHz').toFixed(1),
          mips: +avg('mips').toFixed(1),
        },
        steady: {
          guestFps: +avgSteady('guestFps').toFixed(2),
          uploadFps: +avgSteady('uploadFps').toFixed(2),
          digestMs: +avgSteady('digestMs').toFixed(3),
          drawMs: +avgSteady('drawMs').toFixed(3),
          i2cHz: +avgSteady('i2cHz').toFixed(1),
          mips: +avgSteady('mips').toFixed(1),
        },
        notes: [...new Set(samples.flatMap((s) => s.notes))],
        last: samples.at(-1),
      },
      null,
      2,
    ),
  )
} catch (err) {
  console.error('PROFILE FAILED:', err)
  process.exitCode = 1
} finally {
  await browser.close()
}
