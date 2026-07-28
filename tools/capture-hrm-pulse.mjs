/**
 * Capture the live HRM pulse strip (screenshots + short mp4) against the
 * mock Bluetooth dock — no qemu-wasm required.
 *
 * Usage: node tools/capture-hrm-pulse.mjs
 * Expects vite on http://127.0.0.1:5173
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

const slider = page.getByRole('slider', { name: 'Heart rate' })
await slider.fill('72')
await page.waitForTimeout(400)

async function pulseClip() {
  const all = page.locator('canvas')
  const n = await all.count()
  for (let i = 0; i < n; i++) {
    const box = await all.nth(i).boundingBox()
    if (!box) continue
    if (box.width >= 90 && box.width <= 140 && box.height >= 16 && box.height <= 32) {
      return {
        x: Math.max(0, box.x - 24),
        y: Math.max(0, box.y - 10),
        width: Math.ceil(box.width + 40),
        height: Math.ceil(box.height + 20),
      }
    }
  }
  return null
}

async function dockClip() {
  const heading = page.locator('text=Bluetooth HCI').first()
  const note = page.locator('text=Select a peer to configure').first()
  const hb = await heading.boundingBox()
  const nb = await note.boundingBox()
  if (!hb || !nb) return null
  const y = Math.max(0, hb.y - 16)
  return {
    x: Math.max(0, Math.min(hb.x, nb.x) - 8),
    y,
    width: 460,
    height: Math.min(760, nb.y + nb.height - y + 12),
  }
}

const clip = await pulseClip()
if (!clip) {
  console.error('could not locate pulse strip')
  await page.screenshot({ path: `${OUT}/hrm-pulse-fallback.png` })
  await browser.close()
  process.exit(1)
}

await page.screenshot({ path: `${OUT}/hrm-pulse-72bpm.png`, clip })
const dock = await dockClip()
if (dock) await page.screenshot({ path: `${OUT}/hrm-dock-pulse.png`, clip: dock })

// Wall-clock paced frames so playback BPM matches the live animation.
const framesDir = `${VID}/hrm-pulse-frames`
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })
const fps = 20
const seconds = 4
const frames = Math.round(fps * seconds)
const start = Date.now()
for (let i = 0; i < frames; i++) {
  const target = start + (i * 1000) / fps
  const wait = target - Date.now()
  if (wait > 1) await page.waitForTimeout(wait)
  await page.screenshot({
    path: `${framesDir}/frame-${String(i).padStart(4, '0')}.png`,
    clip,
  })
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

await slider.fill('120')
await page.waitForTimeout(1000)
await page.screenshot({ path: `${OUT}/hrm-pulse-120bpm.png`, clip })
if (dock) await page.screenshot({ path: `${OUT}/hrm-dock-pulse-120.png`, clip: dock })

writeFileSync(
  `${VID}/hrm-pulse-capture.json`,
  JSON.stringify({ clip, frames, fps, seconds, mp4, bpm: [72, 120] }, null, 2),
)

console.log('wrote', `${OUT}/hrm-pulse-72bpm.png`)
console.log('wrote', `${OUT}/hrm-pulse-120bpm.png`)
console.log('wrote', mp4)
await browser.close()
