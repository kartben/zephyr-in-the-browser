/**
 * Capture Trace panel screenshots against the mock backend + a synthetic CTF
 * stream (no qemu-wasm build required).
 *
 *   node tools/screenshot-trace.mjs
 *
 * Writes PNGs under /opt/cursor/artifacts/screenshots/.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import puppeteer from 'puppeteer-core'

const OUT = '/opt/cursor/artifacts/screenshots'
const BASE = process.env.TRACE_SHOT_URL ?? 'http://127.0.0.1:5173'
const URL = `${BASE}/?board=qemu_cortex_a53&app=tracing&backend=mock`

function encU16(n) {
  return [n & 0xff, (n >> 8) & 0xff]
}
function encU32(n) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}
function encU64(n) {
  const out = Array(8).fill(0)
  let x = n
  for (let i = 0; i < 8; i++) {
    out[i] = x & 0xff
    x = Math.floor(x / 256)
  }
  return out
}
function encName(s) {
  const out = Array(20).fill(0)
  for (let i = 0; i < Math.min(20, s.length); i++) out[i] = s.charCodeAt(i)
  return out
}
function record(ts, eid, body) {
  return [...encU64(ts), ...encU16(eid), ...body]
}

/** A short, recognizable schedule: main → thread_a ↔ thread_b with a sleep. */
function buildSyntheticCtf() {
  const main = 0x20001000
  const a = 0x20002000
  const b = 0x20003000
  const bytes = []
  const push = (ts, eid, body) => bytes.push(...record(ts, eid, body))

  push(0, 0x13, [...encU32(main), ...encName('main')])
  push(100, 0x13, [...encU32(a), ...encName('thread_a')])
  push(200, 0x13, [...encU32(b), ...encName('thread_b')])
  push(1_000, 0x11, [...encU32(main), ...encName('main')])
  push(5_000, 0x10, [...encU32(main), ...encName('main')])
  push(5_000, 0x11, [...encU32(a), ...encName('thread_a')])
  // sleep enter hint then switch out → sleep state
  push(8_000, 0x7f, [...encU32(100)])
  push(8_100, 0x10, [...encU32(a), ...encName('thread_a')])
  push(8_100, 0x11, [...encU32(b), ...encName('thread_b')])
  // ISR blip while b runs
  push(9_000, 0x1b, [])
  push(9_400, 0x1c, [])
  push(12_000, 0x10, [...encU32(b), ...encName('thread_b')])
  push(12_000, 0x11, [...encU32(a), ...encName('thread_a')])
  push(15_000, 0x10, [...encU32(a), ...encName('thread_a')])
  push(15_000, 0x11, [...encU32(main), ...encName('main')])
  // More ping-pong so the live window looks busy
  for (let i = 0; i < 12; i++) {
    const t0 = 20_000 + i * 4_000
    const from = i % 2 === 0 ? a : b
    const to = i % 2 === 0 ? b : a
    const fromName = i % 2 === 0 ? 'thread_a' : 'thread_b'
    const toName = i % 2 === 0 ? 'thread_b' : 'thread_a'
    push(t0, 0x10, [...encU32(i === 0 ? main : from), ...encName(i === 0 ? 'main' : fromName)])
    push(t0, 0x11, [...encU32(to), ...encName(toName)])
    if (i % 3 === 2) {
      push(t0 + 1_500, 0x7f, [...encU32(50)])
      push(t0 + 1_600, 0x10, [...encU32(to), ...encName(toName)])
      push(t0 + 1_600, 0x11, [...encU32(from), ...encName(fromName)])
    }
  }
  return Uint8Array.from(bytes)
}

mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
})

const page = await browser.newPage()
page.setDefaultTimeout(60_000)

await page.goto(URL, { waitUntil: 'networkidle0' })

// Wait for the Trace panel chrome (sample primaryPanels expands it).
await page.waitForFunction(() => {
  const titles = [...document.querySelectorAll('button, h2, span, div')]
  return titles.some((el) => (el.textContent || '').trim() === 'Trace')
})

const waitingPath = join(OUT, 'trace-waiting.png')
await page.screenshot({ path: waitingPath, fullPage: false })
console.log('wrote', waitingPath)

// Inject the synthetic CTF stream.
await page.waitForFunction(() => typeof globalThis.__zephyrTraceDebugFeed === 'function')
const ctf = buildSyntheticCtf()
await page.evaluate((arr) => {
  globalThis.__zephyrTraceDebugFeed(Uint8Array.from(arr))
}, [...ctf])

// Let React paint the Gantt.
await page.waitForFunction(() => {
  const canvas = document.querySelector('canvas')
  return canvas && canvas.height > 0
})
await new Promise((r) => setTimeout(r, 400))

const livePath = join(OUT, 'trace-live.png')
await page.screenshot({ path: livePath, fullPage: false })
console.log('wrote', livePath)

// Crop-ish: also grab a tighter shot by scrolling the panel into view and
// screenshoting just that region if we can find the panel card.
const panelHandle = await page.evaluateHandle(() => {
  const buttons = [...document.querySelectorAll('button')]
  const titleBtn = buttons.find((b) => (b.textContent || '').includes('Trace'))
  return titleBtn?.closest('[class*="border"]') ?? titleBtn?.parentElement?.parentElement ?? null
})
const box = await panelHandle.asElement()?.boundingBox()
if (box && box.width > 100) {
  const detailPath = join(OUT, 'trace-panel-detail.png')
  await page.screenshot({
    path: detailPath,
    clip: {
      x: Math.max(0, box.x - 8),
      y: Math.max(0, box.y - 8),
      width: Math.min(1440 - box.x + 8, box.width + 24),
      height: Math.min(900 - box.y + 8, box.height + 24),
    },
  })
  console.log('wrote', detailPath)
}

await browser.close()
