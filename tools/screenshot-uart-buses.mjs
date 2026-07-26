/**
 * Capture real dock screenshots showing UART buses treated like I²C/SPI.
 *
 *   npm run build && npm run preview -- --host 127.0.0.1 --port 4173
 *   node tools/screenshot-uart-buses.mjs
 *
 * Expects a served tree at public/qemu/zephyr/qemu_cortex_a53/shell.dts
 * (the mock backend loads it). Writes PNGs under /opt/cursor/artifacts/screenshots/.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const OUT = '/opt/cursor/artifacts/screenshots'
const BASE = process.env.UART_SHOT_URL ?? 'http://127.0.0.1:4173'
const URL = `${BASE}/?board=qemu_cortex_a53&app=shell&backend=mock`

mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shoot(page, name, clip) {
  const path = join(OUT, name)
  await page.screenshot({ path, ...(clip ? { clip } : { fullPage: false }) })
  console.log('wrote', path)
}

function pad(r, p = 8) {
  return {
    x: Math.max(0, r.x - p),
    y: Math.max(0, r.y - p),
    width: r.width + p * 2,
    height: r.height + p * 2,
  }
}

async function dockRect(page) {
  return page.evaluate(() => {
    let best = null
    for (const n of document.querySelectorAll('div')) {
      const r = n.getBoundingClientRect()
      if (r.width < 280 || r.width > 520 || r.height < 500) continue
      if (r.right < window.innerWidth - 30) continue
      if (!best || r.height > best.height) best = r.toJSON()
    }
    return best
  })
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
})

{
  const page = await browser.newPage()
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 2 })
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60_000 })
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('uart@9000000') ||
      document.body.innerText.includes('UART buses'),
    { timeout: 20_000 },
  )
  await sleep(700)

  await shoot(page, 'uart-buses-01-desktop-devicetree.png')
  let dock = await dockRect(page)
  if (dock) await shoot(page, 'uart-buses-02-dock-devicetree.png', pad(dock))

  await page.evaluate(() => {
    const clickNear = (label) => {
      const text = [...document.querySelectorAll('*')].find(
        (el) => el.children.length === 0 && (el.textContent || '').includes(label),
      )
      let row = text
      while (row && row.parentElement) {
        const btn = row.querySelector('button')
        if (btn) {
          btn.click()
          return
        }
        row = row.parentElement
        if ((row?.getBoundingClientRect().height || 0) > 80) break
      }
    }
    clickNear('uart@9040000')
    clickNear('gnss-nmea')
  })
  await sleep(500)
  dock = await dockRect(page)
  if (dock) await shoot(page, 'uart-buses-03-dock-uart1-expanded.png', pad(dock))

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /Classes|Peripheral classes/i.test(b.getAttribute('aria-label') || b.textContent || ''),
    )
    btn?.click()
  })
  await sleep(500)
  await page.evaluate(() => {
    const mark = [...document.querySelectorAll('*')].find(
      (el) => (el.textContent || '').trim() === 'UART buses',
    )
    mark?.scrollIntoView({ block: 'center' })
  })
  await sleep(300)

  await shoot(page, 'uart-buses-04-desktop-classes.png')
  dock = await dockRect(page)
  if (dock) await shoot(page, 'uart-buses-05-dock-classes.png', pad(dock))

  const groupClip = await page.evaluate(() => {
    const header = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'UART buses',
    )
    if (!header) return null
    let row = header
    while (row?.parentElement && row.getBoundingClientRect().height < 36) {
      row = row.parentElement
    }
    if (!row) return null
    let bottom = row.getBoundingClientRect().bottom
    let node = row.nextElementSibling
    for (let i = 0; i < 3 && node; i++) {
      bottom = Math.max(bottom, node.getBoundingClientRect().bottom)
      node = node.nextElementSibling
    }
    const r = row.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: bottom - r.y }
  })
  if (groupClip) await shoot(page, 'uart-buses-06-uart-group.png', pad(groupClip, 16))

  await page.close()
}

await browser.close()
console.log('done')
