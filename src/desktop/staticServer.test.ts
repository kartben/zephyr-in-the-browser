import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COI_HEADERS } from './coiHeaders'
import { startStaticServer, type StaticServer } from './staticServer'

describe('startStaticServer', () => {
  const servers: StaticServer[] = []
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'zitb-static-'))
    dirs.push(dir)
    return dir
  }

  async function boot(dir: string): Promise<StaticServer> {
    const server = await startStaticServer(dir)
    servers.push(server)
    return server
  }

  it('serves the page with the isolation headers QEMU needs', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Zephyr</title>')
    const server = await boot(dir)

    expect(server.host).toBe('127.0.0.1')
    const res = await fetch(server.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Zephyr')
    expect(res.headers.get('cross-origin-opener-policy')).toBe(COI_HEADERS['Cross-Origin-Opener-Policy'])
    expect(res.headers.get('cross-origin-embedder-policy')).toBe(
      COI_HEADERS['Cross-Origin-Embedder-Policy'],
    )
  })

  it('serves nested assets and wasm with the types the page fetches', async () => {
    const dir = scratch()
    mkdirSync(path.join(dir, 'assets'))
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'export {}')
    writeFileSync(path.join(dir, 'guest.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    const server = await boot(dir)

    const js = await fetch(`${server.url}assets/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')
    expect(js.headers.get('cross-origin-embedder-policy')).toBe('require-corp')

    const wasm = await fetch(`${server.url}guest.wasm`)
    expect(wasm.status).toBe(200)
    expect(wasm.headers.get('content-type')).toBe('application/wasm')
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0x00, 0x61, 0x73, 0x6d]))
  })

  it('does not answer a missing asset with index.html', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'index.html'), 'home')
    const server = await boot(dir)

    const res = await fetch(`${server.url}qemu/missing.wasm`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  })

  it('answers HEAD with headers and an empty body', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'index.html'), 'home')
    const server = await boot(dir)

    const res = await fetch(server.url, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('content-length')).toBe('4')
    expect(await res.text()).toBe('')
  })

  it('rejects methods other than GET and HEAD', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'index.html'), 'home')
    const server = await boot(dir)

    const res = await fetch(server.url, { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
  })

  it('refuses a symlink that points outside the build', async () => {
    const dir = scratch()
    const outside = scratch()
    writeFileSync(path.join(outside, 'secret.txt'), 'nope')
    symlinkSync(outside, path.join(dir, 'escape'))
    const server = await boot(dir)

    const res = await fetch(`${server.url}escape/secret.txt`)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('nope')
  })

  it('refuses a percent-encoded parent segment', async () => {
    const dir = scratch()
    const secret = path.join(path.dirname(dir), `zitb-secret-${process.pid}.txt`)
    writeFileSync(secret, 'nope')
    dirs.push(secret)
    writeFileSync(path.join(dir, 'index.html'), 'home')
    const server = await boot(dir)

    const res = await fetch(`${server.url}%2e%2e%2f${path.basename(secret)}`)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('nope')
  })

  it('refuses a directory that does not exist', async () => {
    await expect(startStaticServer(path.join(tmpdir(), 'zitb-missing-dist'))).rejects.toThrow(
      /npm run build/,
    )
  })
})
