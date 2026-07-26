/**
 * Capture Parts catalog + identity-strip screenshots from ?preview=parts.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173
 *   node tools/screenshot-parts-catalog.mjs
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const OUT = '/opt/cursor/artifacts/screenshots'
const BASE = process.env.PARTS_SHOT_URL ?? 'http://127.0.0.1:5173'
const URL = `${BASE}/?preview=parts`

mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shoot(page, name, clip) {
  const path = join(OUT, name)
  await page.screenshot({ path, ...(clip ? { clip } : { fullPage: false }) })
  console.log('wrote', path)
}

function pad(r, p = 16) {
  return {
    x: Math.max(0, r.x - p),
    y: Math.max(0, r.y - p),
    width: r.width + p * 2,
    height: r.height + p * 2,
  }
}

async function rectFor(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el ? el.getBoundingClientRect().toJSON() : null
  }, selector)
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
})

try {
  const page = await browser.newPage()
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 2 })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60_000 })
  await page.waitForFunction(() => document.body.innerText.includes('Supported parts'), {
    timeout: 15_000,
  })
  await sleep(500)

  await shoot(page, 'parts-ui-01-catalog-dialog.png')

  const dialog = await page.evaluate(() => {
    const title = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && el.textContent === 'Supported parts',
    )
    let root = title
    while (root && root.parentElement) {
      const r = root.getBoundingClientRect()
      if (r.width > 400 && r.height > 400) return r.toJSON()
      root = root.parentElement
    }
    return null
  })
  if (dialog) await shoot(page, 'parts-ui-02-catalog-clip.png', pad(dialog))

  // Close catalog to reveal dock strip + identity card.
  await page.keyboard.press('Escape')
  await sleep(400)
  await page.waitForSelector('[data-preview="dock-strip"]', { timeout: 10_000 })
  await sleep(300)

  await shoot(page, 'parts-ui-03-preview-page.png')

  const strip = await rectFor(page, '[data-preview="dock-strip"]')
  if (strip) await shoot(page, 'parts-ui-04-dock-identity-strip.png', pad(strip))

  const card = await rectFor(page, '[data-preview="identity-card"]')
  if (card) await shoot(page, 'parts-ui-05-identity-card.png', pad(card))

  // Also open the real TopBar PartsCatalog dialog.
  const catalogBtn = await page.waitForSelector('button[aria-label="Supported parts catalog"]')
  await catalogBtn.click()
  await sleep(500)
  await shoot(page, 'parts-ui-06-full-catalog.png')
} finally {
  await browser.close()
}
