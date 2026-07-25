/**
 * Capture Register Map UI screenshots from the live preview page.
 *
 *   node tools/screenshot-register-map.mjs
 *
 * Preview: http://127.0.0.1:5173/?preview=regmap
 * Writes PNGs under /opt/cursor/artifacts/screenshots/.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const OUT = '/opt/cursor/artifacts/screenshots'
const BASE = process.env.REGMAP_SHOT_URL ?? 'http://127.0.0.1:5173'
const URL = `${BASE}/?preview=regmap`

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
  // Force dark theme tokens (the app default).
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.setViewport({ width: 1440, height: 920, deviceScaleFactor: 2 })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60_000 })
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => /^Registers\b/.test((b.textContent || '').trim())),
    { timeout: 15_000 },
  )
  // Wait for auto-opened dialog + expanded Configuration fields.
  await page.waitForSelector('[role="dialog"]', { timeout: 10_000 })
  await sleep(600)

  await shoot(page, 'regmap-01-overview.png')

  // Sensor card only (first card — TMP112), before relying on dialog.
  const cardClip = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('section')]
    const card = cards[0]
    if (!card) return null
    return card.getBoundingClientRect().toJSON()
  })
  if (cardClip) await shoot(page, 'regmap-02-sensor-card.png', rectClip(cardClip, 12))

  // Dialog detail.
  const dialogClip = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return null
    return dialog.getBoundingClientRect().toJSON()
  })
  if (dialogClip) await shoot(page, 'regmap-03-dialog-tmp112.png', rectClip(dialogClip, 16))

  // Close dialog, shoot the three cards with Registers links visible.
  await page.keyboard.press('Escape')
  await sleep(400)
  await shoot(page, 'regmap-04-cards-collapsed.png')

  // Open LSM6DSO registers for the denser IMU map.
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('section')]
    const lsm = cards.find((c) => (c.textContent || '').includes('LSM6DSO'))
    const link = [...(lsm?.querySelectorAll('button') ?? [])].find((b) =>
      /^Registers\b/.test((b.textContent || '').trim()),
    )
    link?.click()
  })
  await page.waitForSelector('[role="dialog"]', { timeout: 5_000 })
  await sleep(300)
  await page.evaluate(() => {
    for (const name of ['CTRL1_XL', 'CTRL2_G', 'WHO_AM_I', 'STATUS_REG', 'CTRL3_C']) {
      const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
        (b.textContent || '').includes(name),
      )
      if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click()
    }
  })
  await sleep(400)
  await shoot(page, 'regmap-05-dialog-lsm6dso-full.png')
  const lsmClip = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return null
    return dialog.getBoundingClientRect().toJSON()
  })
  if (lsmClip) await shoot(page, 'regmap-06-dialog-lsm6dso.png', rectClip(lsmClip, 16))

  await page.close()
}

await browser.close()
console.log('done')
