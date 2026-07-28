/**
 * Capture the live HRM pulse strip (screenshots + short mp4) against the
 * mock Bluetooth dock — no qemu-wasm required.
 *
 * Usage: node tools/capture-hrm-pulse.mjs
 * Expects vite on http://127.0.0.1:5173
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const OUT = '/opt/cursor/artifacts/screenshots'
const VID = '/opt/cursor/artifacts'
mkdirSync(OUT, { recursive: true })
mkdirSync(VID, { recursive: true })

const url =
  'http://127.0.0.1:5173/?board=qemu_cortex_a53&app=bt_peripheral&backend=mock'

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('console:', msg.text())
})

await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

const classView = page.getByRole('button', { name: /^Classes$/i }).first()
if (await classView.count()) {
  await classView.click().catch(() => {})
  await page.waitForTimeout(300)
}

await page.locator('text=On the air').first().waitFor({ timeout: 20000 })

const peerSelect = page.getByLabel('Peer type')
const addBtn = page.getByRole('button', { name: 'Add', exact: true })
await peerSelect.selectOption('hrm')
await addBtn.click()
await page.waitForTimeout(300)
await page.locator('text=Body location').first().waitFor({ timeout: 5000 })
await page.getByRole('slider', { name: 'Heart rate' }).fill('72')
await page.waitForTimeout(400)

async function pulseBox() {
  // The canvas is the ECG strip; include the heart next to it.
  const canvas = page.locator('canvas').filter({ has: page.locator('xpath=..') })
  // Prefer the small ECG canvas inside the inspector.
  const all = page.locator('canvas')
  const n = await all.count()
  for (let i = 0; i < n; i++) {
    const c = all.nth(i)
    const box = await c.boundingBox()
    if (!box) continue
    if (box.width >= 90 && box.width <= 140 && box.height >= 16 && box.height <= 32) {
      return {
        x: Math.max(0, box.x - 22),
        y: Math.max(0, box.y - 8),
        width: box.width + 36,
        height: box.height + 16,
      }
    }
  }
  // Fallback: clip around the Heart rate slider row area.
  const slider = page.getByRole('slider', { name: 'Heart rate' })
  const sbox = await slider.boundingBox()
  if (!sbox) return null
  return { x: sbox.x - 8, y: sbox.y - 40, width: 200, height: 48 }
}

const clip = await pulseBox()
if (!clip) {
  console.error('could not locate pulse strip')
  await page.screenshot({ path: `${OUT}/hrm-pulse-fallback.png` })
  await browser.close()
  process.exit(1)
}

// Still frame at 72 BPM
await page.screenshot({ path: `${OUT}/hrm-pulse-72bpm.png`, clip })
await page.screenshot({ path: `${OUT}/hrm-inspector-72bpm.png`, fullPage: false })

// Frame sequence for mp4 (~3s at 72 BPM ≈ 3–4 beats)
const framesDir = `${VID}/hrm-pulse-frames`
mkdirSync(framesDir, { recursive: true })
const fps = 20
const seconds = 3.2
const frames = Math.round(fps * seconds)
for (let i = 0; i < frames; i++) {
  await page.screenshot({
    path: `${framesDir}/frame-${String(i).padStart(4, '0')}.png`,
    clip,
  })
  await page.waitForTimeout(1000 / fps)
}

const mp4 = `${VID}/hrm-pulse-72bpm.mp4`
const ff = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    `${framesDir}/frame-%04d.png`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '18',
    mp4,
  ],
  { encoding: 'utf8' },
)
if (ff.status !== 0) {
  console.error(ff.stderr)
  process.exit(ff.status ?? 1)
}

// Also capture a faster rate so rhythm is obvious in a still pair.
await page.getByRole('slider', { name: 'Heart rate' }).fill('120')
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/hrm-pulse-120bpm.png`, clip })

writeFileSync(
  `${VID}/hrm-pulse-capture.json`,
  JSON.stringify({ clip, frames, fps, mp4, bpm: [72, 120] }, null, 2),
)

console.log('wrote', `${OUT}/hrm-pulse-72bpm.png`)
console.log('wrote', `${OUT}/hrm-pulse-120bpm.png`)
console.log('wrote', mp4)
await browser.close()
