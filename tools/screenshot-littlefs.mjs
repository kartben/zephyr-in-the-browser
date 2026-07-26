/**
 * Capture LittleFS / SPI flash widget screenshots from the live preview page.
 *
 *   node tools/screenshot-littlefs.mjs
 *
 * Preview: http://127.0.0.1:5173/?preview=littlefs
 * Writes PNGs under /opt/cursor/artifacts/screenshots/.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const OUT = '/opt/cursor/artifacts/screenshots'
const BASE = process.env.LITTLEFS_SHOT_URL ?? 'http://127.0.0.1:5173'
const URL = `${BASE}/?preview=littlefs`

mkdirSync(OUT, { recursive: true })

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function shoot(page, name, clip) {
  const path = join(OUT, name)
  await page.screenshot({ path, ...(clip ? { clip } : { fullPage: false }) })
  console.log('wrote', path)
}

function rectClip(r, pad = 10) {
  return {
    x: Math.max(0, r.x - pad),
    y: Math.max(0, r.y - pad),
    width: r.width + pad * 2,
    height: r.height + pad * 2,
  }
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
})

{
  const page = await browser.newPage()
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60_000 })
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button')].some((b) =>
        /^Filesystem$/i.test((b.textContent || '').trim()),
      ),
    { timeout: 20_000 },
  )
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 })
  await sleep(700)

  await shoot(page, 'littlefs-01-overview.png')

  const dialogClip = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return null
    return dialog.getBoundingClientRect().toJSON()
  })
  if (dialogClip) await shoot(page, 'littlefs-02-filesystem-dialog.png', rectClip(dialogClip, 18))

  // Select note.txt for a text preview.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
      (b.textContent || '').includes('note.txt'),
    )
    btn?.click()
  })
  await sleep(400)
  const dialogClip2 = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return null
    return dialog.getBoundingClientRect().toJSON()
  })
  if (dialogClip2) {
    await shoot(page, 'littlefs-03-file-preview.png', rectClip(dialogClip2, 18))
  }

  await page.keyboard.press('Escape')
  await sleep(400)

  const cardClip = await page.evaluate(() => {
    const card = document.querySelector('#shot-flash-card')
    if (!card) return null
    return card.getBoundingClientRect().toJSON()
  })
  if (cardClip) await shoot(page, 'littlefs-04-flash-card.png', rectClip(cardClip, 14))

  await page.close()
}

await browser.close()
console.log('done')
