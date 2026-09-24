/**
 * Open the dev server in an Electron window.
 *
 * Builds the main process, starts Vite on 127.0.0.1:5173 (it already sends
 * the isolation headers), then launches Electron against that URL. Closing
 * the window stops the dev server.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV_HOST = '127.0.0.1'
const DEV_PORT = 5173
const DEV_URL = `http://${DEV_HOST}:${DEV_PORT}/`
const READY_TIMEOUT_MS = 90_000

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const built = spawnSync(npm, ['run', 'build:electron'], { cwd: root, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
if (typeof electronBinary !== 'string') {
  throw new Error('Could not resolve the Electron binary')
}

const vite = spawn(npm, ['run', 'dev', '--', '--port', String(DEV_PORT), '--strictPort', '--host', DEV_HOST], {
  cwd: root,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
})

let electron
let stopping = false

function killTree(child) {
  if (!child?.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      // The process was not a group leader. Fall through to a direct signal.
    }
  }
  child.kill('SIGTERM')
}

function shutdown(code) {
  if (stopping) return
  stopping = true
  killTree(vite)
  killTree(electron)
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
vite.on('exit', (code) => {
  if (!stopping) shutdown(code ?? 1)
})

try {
  await waitForPort(DEV_PORT, DEV_HOST, READY_TIMEOUT_MS)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  shutdown(1)
}

electron = spawn(electronBinary, ['.'], {
  cwd: root,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: { ...process.env, ELECTRON_DEV_URL: DEV_URL },
})
electron.on('exit', (code) => shutdown(code ?? 0))

function waitForPort(port, host, timeoutMs) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host }, () => {
        socket.end()
        resolve()
      })
      socket.on('error', () => {
        socket.destroy()
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Dev server did not open ${host}:${port}`))
        } else {
          setTimeout(attempt, 200)
        }
      })
    }
    attempt()
  })
}
