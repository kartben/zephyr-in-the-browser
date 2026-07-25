/**
 * Capture screenshots of the real RtcBody preview page.
 * Assumes `npm run dev` is listening on PORT (default 5173).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const outDir = '/opt/cursor/artifacts'
mkdirSync(outDir, { recursive: true })
const port = process.env.PORT || '5173'
const url = `http://127.0.0.1:${port}/tools/rtc-preview.html`

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 960, height: 780 }, deviceScaleFactor: 2 })
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForSelector('#shot-armed [data-testid="rtc-body"]')
await page.waitForSelector('#shot-fired [data-testid="rtc-alarm-fired"]')

await page.locator('#shot-armed').screenshot({ path: join(outDir, 'rtc-widget-armed.png') })
await page.locator('#shot-fired').screenshot({ path: join(outDir, 'rtc-widget-fired.png') })
await page.screenshot({ path: join(outDir, 'rtc-widget-both.png') })

await browser.close()
console.log('Wrote', outDir)
