/**
 * Capture Trace panel screenshots against the mock backend + a synthetic CTF
 * stream (no qemu-wasm build required).
 *
 *   node tools/screenshot-trace.mjs
 *
 * Writes PNGs under /opt/cursor/artifacts/screenshots/.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * ~4.5 s of schedule activity so the default 4 s live window fills the axis
 * with second-scale ticks (same glance window as the tracing sample).
 */
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

  // Slice length ≈ 100 ms → 45 slices ≈ 4.5 s.
  let t = 2_000_000
  for (let i = 0; i < 45; i++) {
    const from = i % 2 === 0 ? a : b
    const to = i % 2 === 0 ? b : a
    const fromName = i % 2 === 0 ? 'thread_a' : 'thread_b'
    const toName = i % 2 === 0 ? 'thread_b' : 'thread_a'
    if (i === 0) {
      push(t, 0x10, [...encU32(main), ...encName('main')])
    } else {
      push(t, 0x10, [...encU32(from), ...encName(fromName)])
    }
    push(t, 0x11, [...encU32(to), ...encName(toName)])
    if (i % 5 === 2) {
      push(t + 25_000_000, 0x7f, [...encU32(40)])
      push(t + 30_000_000, 0x10, [...encU32(to), ...encName(toName)])
      push(t + 30_000_000, 0x11, [...encU32(from), ...encName(fromName)])
      t += 120_000_000
    } else {
      t += 100_000_000
    }
    if (i % 7 === 0) {
      push(t - 8_000_000, 0x1b, [])
      push(t - 4_000_000, 0x1c, [])
    }
  }
  return Uint8Array.from(bytes)
}

async function shoot(page, name) {
  const path = join(OUT, name)
  await page.screenshot({ path, fullPage: false })
  console.log('wrote', path)
}

async function prepare(page) {
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => typeof globalThis.__zephyrTraceDebugFeed === 'function')
  // Expand Trace if collapsed.
  await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')]
    const title = spans.find((s) => s.textContent?.trim() === 'Trace')
    const card = title?.closest('[class*="shadow"]')
    const chevron = [...(card?.querySelectorAll('button') ?? [])].find((b) =>
      (b.getAttribute('aria-label') || '').toLowerCase().includes('expand'),
    )
    chevron?.click()
  })
  await new Promise((r) => setTimeout(r, 200))
  const ctf = buildSyntheticCtf()
  await page.evaluate((arr) => globalThis.__zephyrTraceDebugFeed(Uint8Array.from(arr)), [...ctf])
  await page.waitForFunction(
    () => document.querySelector('canvas') && document.querySelector('canvas').height > 40,
    { timeout: 10_000 },
  )
  await new Promise((r) => setTimeout(r, 400))
}

mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})

// Desktop
{
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })
  await prepare(page)
  await shoot(page, 'trace-desktop.png')
  const clip = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')]
    const title = spans.find((s) => s.textContent?.trim() === 'Trace')
    const card = title?.closest('[class*="shadow"]')
    if (!card) return null
    const r = card.getBoundingClientRect()
    return {
      x: Math.max(0, r.x - 8),
      y: Math.max(0, r.y - 8),
      width: Math.min(window.innerWidth - r.x + 8, r.width + 16),
      height: Math.min(window.innerHeight - r.y + 8, r.height + 16),
    }
  })
  if (clip?.width > 80) {
    await page.screenshot({ path: join(OUT, 'trace-desktop-detail.png'), clip })
    console.log('wrote', join(OUT, 'trace-desktop-detail.png'))
  }
  await page.close()
}

// Mobile (iPhone-ish)
{
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  await prepare(page)
  // Collapse the dock so the Trace card has the stage.
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label*="device dock"], button[title*="device dock"]')
    if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click()
  })
  await new Promise((r) => setTimeout(r, 300))
  await shoot(page, 'trace-mobile.png')
  const clip = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span')]
    const title = spans.find((s) => s.textContent?.trim() === 'Trace')
    const card = title?.closest('[class*="shadow"]')
    if (!card) return null
    const r = card.getBoundingClientRect()
    return {
      x: Math.max(0, r.x - 4),
      y: Math.max(0, r.y - 4),
      width: Math.min(window.innerWidth - r.x + 4, r.width + 8),
      height: Math.min(window.innerHeight - r.y + 4, r.height + 8),
    }
  })
  if (clip?.width > 80) {
    await page.screenshot({ path: join(OUT, 'trace-mobile-detail.png'), clip })
    console.log('wrote', join(OUT, 'trace-mobile-detail.png'))
  }
  await page.close()
}

await browser.close()
