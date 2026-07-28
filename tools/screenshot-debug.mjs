/**
 * Capture Debug panel screenshots against the mock backend and a synthetic
 * stopped session (no qemu-wasm build, no gdbstub required).
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173
 *   node tools/screenshot-debug.mjs
 *
 * Seeds the dev-only `__zephyrGdbForceSession` hook with the state a real stop
 * publishes — registers, threads, a call stack, a peek window — so the paused
 * surfaces can be laid out and reviewed. Run control is inert here: there is no
 * stub behind the buttons.
 *
 * Writes PNGs under /opt/cursor/artifacts/screenshots/.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const OUT = process.env.SHOT_OUT ?? '/opt/cursor/artifacts/screenshots'
const BASE = process.env.DEBUG_SHOT_URL ?? 'http://127.0.0.1:5173'
const URL = `${BASE}/?board=qemu_cortex_a53&app=shell&backend=mock`

mkdirSync(OUT, { recursive: true })

/** A plausible AArch64 stop inside the shell thread. */
function fakeSession() {
  const hex = (n) => n.toString(16).padStart(16, '0')
  const gpr = (i) => `X${String(i).padStart(2, '0')}=${hex(0x40000000 + i * 0x40)}`
  const registers = [
    `PC=${hex(0x4003b018)}`,
    `SP=${hex(0x40011f00)}`,
    `X30=${hex(0x4001a044)}`,
    ...Array.from({ length: 30 }, (_, i) => gpr(i)),
    'PSTATE=60000005',
  ].join('\n')

  const frame = (addr, label, origin, slot) => ({
    addr,
    label,
    fn: null,
    origin,
    slot: slot ?? null,
  })

  const window256 = Array.from({ length: 256 }, (_, i) =>
    (i % 32 === 0 ? 0x7a : i % 7 === 0 ? 0x00 : 0x41 + (i % 26)).toString(16).padStart(2, '0'),
  ).join('')

  return {
    available: true,
    attached: true,
    paused: true,
    pc: '4003b018',
    pcLabel: 'shell_process+0x18',
    summary: 'shell_process+0x18',
    registers,
    registersLoading: false,
    hasSymbols: true,
    threadInfo: true,
    regArch: 'aarch64',
    breakpoints: [
      { addr: 0x4003b000, addrHex: '4003b000', label: 'shell_process' },
      { addr: 0x4001a020, addrHex: '4001a020', label: 'k_msleep+0x2c' },
    ],
    memory: { addr: 0x40011f00, hex: window256 },
    threads: [
      {
        addr: 0x40012a80,
        name: 'shell_uart',
        entry: 0x4003b000,
        prio: 14,
        state: 0,
        current: true,
        sp: 0x40011f00,
        stackStart: 0x40011000,
        stackSize: 2048,
        pendedOn: null,
        waitingOn: null,
      },
      {
        addr: 0x40012c00,
        name: 'main',
        entry: 0x40039000,
        prio: 0,
        state: 0x02,
        current: false,
        sp: 0x40014e40,
        stackStart: 0x40014000,
        stackSize: 4096,
        pendedOn: 0x40015100,
        waitingOn: { name: 'sem_ready', addr: 0x40015100, kind: 'sem' },
      },
      {
        addr: 0x40012d80,
        name: 'idle',
        entry: 0x40038000,
        prio: 15,
        state: 0x80,
        current: false,
        sp: 0x40016f00,
        stackStart: 0x40016000,
        stackSize: 1024,
        pendedOn: null,
        waitingOn: null,
      },
    ],
    threadsLoading: false,
    threadsError: null,
    stack: [
      frame(0x4003b018, 'shell_process+0x18', 'pc'),
      frame(0x4001a044, 'k_msleep+0x44', 'fp', 0x40011f28),
      frame(0x40039120, 'shell_thread+0x120', 'fp', 0x40011f68),
      frame(0x40021004, 'z_thread_entry+0x4', 'fp', 0x40011fa8),
    ],
    stackMethod: 'fp',
    stackLoading: false,
    stackTruncated: false,
  }
}

async function prepare(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await new Promise((r) => setTimeout(r, 1500))
  await page.evaluate((state) => {
    globalThis.__zephyrGdbForceSession?.(state)
  }, fakeSession())
  await new Promise((r) => setTimeout(r, 600))
}

/** Click one of the Debug panel's inspect tabs by its label. */
async function openTab(page, label) {
  await page.evaluate((want) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === want,
    )
    button?.click()
  }, label)
  await new Promise((r) => setTimeout(r, 400))
}

/**
 * Shoot the panel element itself rather than a computed clip — the stage
 * bottom-anchors the card, and an element handle scrolls it into view for us.
 */
async function shootPanel(page, name) {
  await page.evaluate(() => {
    const title = [...document.querySelectorAll('span, h2, h3')].find(
      (n) => n.textContent?.trim() === 'Debug',
    )
    const card = title?.closest('[class*="shadow"], section, article')
    card?.setAttribute('data-shot-target', 'debug')
  })
  const path = join(OUT, name)
  const card = await page.$('[data-shot-target="debug"]')
  if (card) await card.screenshot({ path })
  else await page.screenshot({ path })
  console.log('wrote', path)
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
})

const page = await browser.newPage()
// Tall enough that the whole panel fits in one clip, tabs and footnote included.
await page.setViewport({ width: 1280, height: 1400, deviceScaleFactor: 2 })
await prepare(page)

for (const [label, file] of [
  ['Stack', 'debug-stack.png'],
  ['CPU', 'debug-cpu.png'],
  ['Mem', 'debug-mem.png'],
  ['Threads', 'debug-threads.png'],
]) {
  await openTab(page, label)
  await shootPanel(page, file)
}

// The other half of the Stack tab: a guest without frame pointers, where the
// frames are scanned and the pane has to say so.
await page.evaluate(() => {
  globalThis.__zephyrGdbForceSession?.({
    stackMethod: 'scan',
    stackTruncated: true,
    stack: [
      { addr: 0x4003b018, label: 'shell_process+0x18', fn: null, origin: 'pc', slot: null },
      { addr: 0x4001a044, label: 'k_msleep+0x44', fn: null, origin: 'lr', slot: null },
      { addr: 0x40039120, label: 'shell_thread+0x120', fn: null, origin: 'scan', slot: 0x40011f68 },
      { addr: 0x40021004, label: 'z_thread_entry+0x4', fn: null, origin: 'scan', slot: 0x40011fa8 },
    ],
  })
})
await openTab(page, 'Stack')
await shootPanel(page, 'debug-stack-scan.png')

await browser.close()
