import path from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { startStaticServer, type StaticServer } from '../src/desktop/staticServer'

/**
 * Desktop shell for the page.
 *
 * The renderer is the same Vite build the website ships. It is loaded over
 * loopback, not file://, so cross-origin isolation holds and QEMU can boot.
 * Node is not exposed to the page: the window is a browser tab with a frame.
 */

let server: StaticServer | null = null
let appUrl = ''

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setName('Zephyr in the Browser')
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  void app
    .whenReady()
    .then(open)
    .catch(async (err: unknown) => {
      await server?.close().catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      dialog.showErrorBox('Zephyr in the Browser', message)
      app.exit(1)
    })

  app.on('activate', () => {
    if (appUrl && BrowserWindow.getAllWindows().length === 0) void createWindow(appUrl)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    void server?.close()
  })
}

async function open(): Promise<void> {
  appUrl = devUrlFromEnv() ?? (await serveDist())
  await createWindow(appUrl)
}

async function serveDist(): Promise<string> {
  const dist = path.join(app.getAppPath(), 'dist')
  server = await startStaticServer(dist)
  return server.url
}

async function createWindow(url: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Zephyr in the Browser',
    // Matches the page's dark background so the window does not flash white.
    backgroundColor: '#1c1c1f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Links in the page open in the system browser. The window stays on the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isHttp(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (sameOrigin(target, url)) return
    event.preventDefault()
    if (isHttp(target)) void shell.openExternal(target)
  })

  await win.loadURL(url)
}

function devUrlFromEnv(): string | null {
  const raw = process.env.ELECTRON_DEV_URL
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`ELECTRON_DEV_URL is not a URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ELECTRON_DEV_URL must be http or https')
  }
  return url.href
}

function sameOrigin(target: string, base: string): boolean {
  try {
    return new URL(target).origin === new URL(base).origin
  } catch {
    return false
  }
}

function isHttp(target: string): boolean {
  try {
    const protocol = new URL(target).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
