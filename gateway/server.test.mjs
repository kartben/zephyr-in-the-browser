/**
 * Lifecycle tests against test/fake-passt.mjs (a UNIX-socket echo with passt's
 * CLI surface), so they run anywhere node does — no Linux, no Docker. What
 * they prove: auth and capacity close codes, transparent byte piping in both
 * directions, backend-failure reporting, and that teardown reaps children.
 */

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import WebSocket from 'ws'
import { startGateway } from './server.mjs'

const FAKE_PASST = fileURLToPath(new URL('./test/fake-passt.mjs', import.meta.url))

const quiet = () => {}

function start(overrides = {}) {
  return startGateway(
    {
      port: 0,
      host: '127.0.0.1',
      passtBin: process.execPath,
      passtDefaultArgs: [FAKE_PASST],
      ...overrides,
    },
    { log: quiet },
  )
}

async function connected(url) {
  const ws = new WebSocket(url)
  await once(ws, 'open')
  return ws
}

test('healthz and the banner page respond without a token', async () => {
  const gw = await start({ token: 'sesame' })
  try {
    const health = await fetch(`http://127.0.0.1:${gw.port}/healthz`)
    assert.deepEqual(await health.json(), { ok: true, clients: 0, max: 8, version: '0.1.0' })
    const banner = await fetch(`http://127.0.0.1:${gw.port}/`)
    assert.match(await banner.text(), /gateway/)
    const missing = await fetch(`http://127.0.0.1:${gw.port}/nope`)
    assert.equal(missing.status, 404)
  } finally {
    await gw.close()
  }
})

test('pipes bytes transparently in both directions', async () => {
  const gw = await start()
  try {
    const ws = await connected(`ws://127.0.0.1:${gw.port}/`)
    const payload = Buffer.from([0, 0, 0, 14, ...Array.from({ length: 14 }, (_, i) => i)])
    const echoed = []
    let got = 0
    const done = new Promise((resolve) => {
      ws.on('message', (data) => {
        echoed.push(data)
        got += data.length
        if (got >= payload.length) resolve()
      })
    })
    ws.send(payload)
    await done
    assert.deepEqual(Buffer.concat(echoed), payload)
    ws.close(1000)
    await once(ws, 'close')
  } finally {
    await gw.close()
  }
})

test('rejects a bad token with 4001 after completing the handshake', async () => {
  const gw = await start({ token: 'sesame' })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/?token=wrong`)
    const [code] = await once(ws, 'close')
    assert.equal(code, 4001)

    const good = await connected(`ws://127.0.0.1:${gw.port}/?token=sesame`)
    good.close(1000)
    await once(good, 'close')
  } finally {
    await gw.close()
  }
})

test('rejects connections beyond MAX_CLIENTS with 4002', async () => {
  const gw = await start({ maxClients: 1 })
  try {
    const first = await connected(`ws://127.0.0.1:${gw.port}/`)
    const second = new WebSocket(`ws://127.0.0.1:${gw.port}/`)
    const [code] = await once(second, 'close')
    assert.equal(code, 4002)
    first.close(1000)
    await once(first, 'close')
  } finally {
    await gw.close()
  }
})

test('reports a dead backend with 4003', async () => {
  const gw = await start({ passtDefaultArgs: [FAKE_PASST, '--exit-early'] })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/`)
    const [code] = await once(ws, 'close')
    assert.equal(code, 4003)
  } finally {
    await gw.close()
  }
})

test('client disconnect reaps the passt child', async () => {
  const gw = await start()
  try {
    const ws = await connected(`ws://127.0.0.1:${gw.port}/`)
    assert.equal(gw.clientCount(), 1)
    ws.close(1000)
    await once(ws, 'close')
    // Teardown is event-driven; give the close handlers one beat.
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(gw.clientCount(), 0)
  } finally {
    await gw.close()
  }
})

test('shutdown closes live clients with 1001', async () => {
  const gw = await start()
  const ws = await connected(`ws://127.0.0.1:${gw.port}/`)
  const closed = once(ws, 'close')
  await gw.close()
  const [code] = await closed
  assert.equal(code, 1001)
})

test('firstNameserver parses resolv.conf and tolerates absence', async (t) => {
  const { writeFileSync, rmSync } = await import('node:fs')
  const { firstNameserver } = await import('./server.mjs')
  const path = `/tmp/probe-resolv-${process.pid}.conf`
  writeFileSync(path, '# comment\nsearch example.test\nnameserver 10.9.8.7\nnameserver 1.1.1.1\n')
  t.after(() => rmSync(path, { force: true }))
  assert.equal(firstNameserver(path), '10.9.8.7')
  assert.equal(firstNameserver('/nonexistent/resolv.conf'), null)
})
