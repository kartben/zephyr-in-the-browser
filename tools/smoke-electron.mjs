/**
 * Confirms the desktop window is cross-origin isolated and can see JSPI.
 *
 * The production Electron path serves dist/ from loopback. file:// cannot
 * send the headers QEMU needs, and a window that is not isolated refuses to
 * boot the emulator. This does not boot a guest (that is tools/smoke-boot.mjs).
 * It opens the unpackaged production window and checks the two conditions
 * createQemuBackend checks before it fetches anything.
 *
 *   npm run build && npm run build:electron
 *   node tools/smoke-electron.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distIndex = path.join(root, 'dist', 'index.html')
const main = path.join(root, 'dist-electron', 'main.js')

if (!existsSync(distIndex) || !existsSync(main)) {
  console.error('Build first: npm run build && npm run build:electron')
  process.exit(1)
}

const require = createRequire(import.meta.url)
const executablePath = require('electron')
if (typeof executablePath !== 'string') {
  console.error('Could not resolve the Electron binary')
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_DEV_URL

const app = await electron.launch({
  executablePath,
  cwd: root,
  args: [root],
  env,
  colorScheme: 'dark',
  timeout: 60_000,
})

const outDir = path.join(root, 'smoke-out')
mkdirSync(outDir, { recursive: true })

try {
  const window = await app.firstWindow()
  window.on('pageerror', (err) => console.error('pageerror', err))
  await window.getByRole('combobox', { name: 'Board', exact: true }).waitFor({ timeout: 30_000 })

  // Settings is real React UI, so this checks the window takes a click and
  // shows a dialog. The terminal draws onto a canvas, which this probe cannot
  // read back as text.
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByLabel('Bridge WebSocket URL').waitFor({ timeout: 10_000 })
  await window.keyboard.press('Escape')

  const facts = await window.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated,
    jspi:
      typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function',
    title: document.title,
    href: location.href,
  }))

  await window.screenshot({ path: path.join(outDir, 'electron.png') })
  console.log(JSON.stringify(facts))

  if (!facts.isolated) {
    console.error('Page is not cross-origin isolated')
    process.exitCode = 1
  }
  if (!facts.jspi) {
    console.error('JSPI is missing (WebAssembly.Suspending / promising)')
    process.exitCode = 1
  }
  if (!facts.href.startsWith('http://127.0.0.1:')) {
    console.error(`Expected a loopback URL, got ${facts.href}`)
    process.exitCode = 1
  }
} finally {
  await app.close()
}
