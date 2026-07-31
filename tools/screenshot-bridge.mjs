/**
 * Capture Settings / Trace Live board / Network screenshots for the PR.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = '/opt/cursor/artifacts/screenshots'
mkdirSync(OUT, { recursive: true })

const BRIDGE_URL = 'ws://127.0.0.1:8740/?token=demo'
const APP = 'http://127.0.0.1:5173/'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

const settingsBtn = () => page.locator('header button[aria-label="Settings"]')

await page.goto(APP, { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.goto(APP, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.screenshot({ path: join(OUT, '01-app-default.png'), fullPage: false })

await settingsBtn().click()
await page.waitForTimeout(400)
await page.screenshot({ path: join(OUT, '02-settings-open.png'), fullPage: false })

const dialog = page.getByRole('dialog', { name: 'Settings' })
await dialog.locator('input[type="checkbox"]').check()
await dialog.getByLabel('Bridge WebSocket URL').fill(BRIDGE_URL)
await dialog.getByLabel('Bridge WebSocket URL').press('Enter')
await page.waitForTimeout(400)
await dialog.getByRole('button', { name: 'How to run the bridge' }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: join(OUT, '03-settings-help.png'), fullPage: false })

const connectBtn = dialog.getByRole('button', { name: /^(Connect|Retry|Disconnect)$/ })
const label = await connectBtn.textContent()
if (label && /Connect|Retry/.test(label)) await connectBtn.click()
await page.waitForTimeout(2500)
await page.screenshot({ path: join(OUT, '04-settings-connected.png'), fullPage: false })

await page.keyboard.press('Escape')
await page.locator('button[aria-label="Dismiss settings"]').click({ force: true }).catch(() => {})
await page.waitForTimeout(400)

// Force Trace visible: open dock panels if needed
await page.evaluate(() => {
  // Expand trace via dock store if exposed — fallback: click text
})
const live = page.getByText('Live board')
if (await live.count()) {
  await live.first().scrollIntoViewIfNeeded()
} else {
  // Enable bridge already — Trace row should appear; click Trace in dock
  const t = page.locator('.font-medium', { hasText: 'Trace' }).first()
  if (await t.count()) await t.click()
  await page.waitForTimeout(600)
}
await page.screenshot({ path: join(OUT, '05-trace-live-board.png'), fullPage: false })

const net = page.locator('.font-medium', { hasText: 'Network' }).first()
if (await net.count()) {
  await net.click()
  await page.waitForTimeout(800)
}
await page.screenshot({ path: join(OUT, '06-network-panel.png'), fullPage: false })

await page.goto(`${APP}?bridge=${encodeURIComponent(BRIDGE_URL)}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
await settingsBtn().click()
await page.waitForTimeout(1000)
await page.screenshot({ path: join(OUT, '07-deeplink-settings.png'), fullPage: false })

await page.keyboard.press('Escape')
await page.locator('button[aria-label="Dismiss settings"]').click({ force: true }).catch(() => {})
await page.waitForTimeout(500)
await page.screenshot({ path: join(OUT, '08-after-deeplink.png'), fullPage: false })

await browser.close()
console.log('Wrote screenshots to', OUT)
