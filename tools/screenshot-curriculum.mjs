/**
 * Capture the curriculum Learn tab and tour card against the mock backend.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
 *   node tools/screenshot-curriculum.mjs
 *
 * Writes PNGs under /opt/cursor/artifacts/screenshots/.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const OUT = process.env.SHOT_OUT ?? '/opt/cursor/artifacts/screenshots'
const BASE = process.env.CURRICULUM_SHOT_URL ?? 'http://127.0.0.1:5173'

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
})

const page = await browser.newPage()
await page.setViewportSize({ width: 1360, height: 900 })

async function shoot(name, selector) {
  const path = join(OUT, name)
  const el = selector ? page.locator(selector).first() : null
  if (el && (await el.count())) await el.screenshot({ path })
  else await page.screenshot({ path, fullPage: false })
  console.log('wrote', path)
}

await page.goto(`${BASE}/?board=qemu_cortex_a53&app=shell&backend=mock&learn=1`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
})
await page.waitForTimeout(1800)
await page.waitForSelector('[data-shot-target="gallery"]')
await shoot('curriculum-learn-tab.png', '[data-shot-target="gallery"]')

await page.getByRole('tab', { name: 'Apps' }).click()
await page.waitForTimeout(300)
await shoot('curriculum-apps-tab.png', '[data-shot-target="gallery"]')

await page.getByRole('tab', { name: 'Learn' }).click()
await page.getByRole('button', { name: 'Start' }).click()
await page.waitForSelector('[data-shot-target="tour"]')
await page.waitForTimeout(400)
await shoot('curriculum-step-meet.png', '[data-shot-target="tour"]')
await page.screenshot({ path: join(OUT, 'curriculum-page-meet.png') })
console.log('wrote', join(OUT, 'curriculum-page-meet.png'))

await page.evaluate(() => {
  globalThis.__zephyrCurriculumShow?.('env_node', 1)
})
await page.waitForTimeout(400)
await shoot('curriculum-step-cmake.png', '[data-shot-target="tour"]')

await page.evaluate(() => {
  globalThis.__zephyrCurriculumShow?.('env_node', 4)
})
await page.waitForTimeout(400)
await shoot('curriculum-step-rtio.png', '[data-shot-target="tour"]')
await page.screenshot({ path: join(OUT, 'curriculum-page-rtio.png') })
console.log('wrote', join(OUT, 'curriculum-page-rtio.png'))

await browser.close()
