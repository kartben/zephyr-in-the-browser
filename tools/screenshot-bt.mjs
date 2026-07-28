import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '/opt/cursor/artifacts/screenshots'
mkdirSync(OUT, { recursive: true })

const url =
  'http://127.0.0.1:5173/?board=qemu_cortex_a53&app=bt_peripheral'

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('console:', msg.text())
})

await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

const classView = page.getByRole('button', { name: /^Classes$/i }).first()
if (await classView.count()) {
  await classView.click().catch(() => {})
  await page.waitForTimeout(300)
}

await page.locator('text=On the air').first().waitFor({ timeout: 15000 })

async function clipPanel(name) {
  const btHeading = page.locator('text=Bluetooth HCI').first()
  const titleBox = await btHeading.boundingBox()
  const note = page.locator('text=Select a peer to configure').first()
  const noteBox = await note.boundingBox()
  if (!titleBox || !noteBox) {
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
    return
  }
  const x = Math.max(0, Math.min(titleBox.x, noteBox.x) - 12)
  const y = Math.max(0, titleBox.y - 20)
  const width = 480
  const height = Math.min(900 - y, noteBox.y + noteBox.height - y + 16)
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: { x, y, width, height },
  })
}

const peerSelect = page.getByLabel('Peer type')
const addBtn = page.getByRole('button', { name: 'Add', exact: true })

// --- HRM inspector ---
await peerSelect.selectOption('hrm')
await addBtn.click()
await page.waitForTimeout(250)
await page.locator('text=Body location').first().waitFor({ timeout: 5000 })
await page.getByRole('slider', { name: 'Heart rate' }).fill('96')
await page.waitForTimeout(200)
await clipPanel('bt-inspector-hrm')
await page.screenshot({ path: `${OUT}/bt-dock-hrm.png`, fullPage: false })

// --- Scanner inspector (multi-peer roster) ---
await peerSelect.selectOption('scanner')
await addBtn.click()
await page.waitForTimeout(250)
await page.locator('text=Adv reports').first().waitFor({ timeout: 5000 })
await clipPanel('bt-inspector-scanner')

// --- Advertiser inspector ---
await peerSelect.selectOption('advertiser')
await addBtn.click()
await page.waitForTimeout(250)
await page.getByLabel('Local name').waitFor({ timeout: 5000 })
await clipPanel('bt-inspector-advertiser')

// --- Roster only (deselect) ---
await page.getByRole('button', { name: /Advertiser/ }).first().click()
await page.waitForTimeout(200)
await clipPanel('bt-roster-noselection')

// --- Speaker (A2DP) inspector ---
await peerSelect.selectOption('speaker')
await addBtn.click()
await page.waitForTimeout(250)
await page.locator('text=A2DP').first().waitFor({ timeout: 5000 })
await clipPanel('bt-inspector-speaker')

// Floating window with speaker selected
const pop = page
  .locator('[aria-label*="Pop" i], button[title*="Pop" i], button[title*="window" i]')
  .first()
if (await pop.count()) {
  await pop.click().catch(() => {})
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/bt-floating-inspector.png` })
}

console.log('wrote mockup screenshots to', OUT)
await browser.close()
