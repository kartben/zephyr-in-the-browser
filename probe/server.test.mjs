import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { CH_CTF, CH_CTRL, CLOSE_UNAUTHORIZED, decodeCtrl, decodeFrame, encodeCtrl } from './protocol.mjs'
import { startProbeBridge } from './server.mjs'

function fakePorts(paths) {
  return paths.map((path) => ({
    path,
    manufacturer: 'Test',
    serialNumber: null,
    vendorId: '0000',
    productId: '0000',
    friendlyName: 'Test',
  }))
}

function openSerialFake({ path, baudRate, onData, onError, onClose }) {
  let closed = false
  return {
    path,
    baudRate,
    close() {
      if (closed) return
      closed = true
      onClose()
    },
    write() {
      return !closed
    },
    /** test helper */
    _push(buf) {
      if (!closed) onData(Buffer.from(buf))
    },
    _fail(msg) {
      onError(new Error(msg))
    },
  }
}

async function withBridge(fn, overrides = {}) {
  /** @type {ReturnType<typeof openSerialFake> | null} */
  let current = null
  const bridge = await startProbeBridge(
    {
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      maxClients: 2,
      baudRate: 115200,
      serialPath: null,
      gdbHost: '127.0.0.1',
      gdbPort: 3333,
      pagesUrl: 'https://example.test/',
      noTui: true,
      ...overrides,
    },
    {
      log: () => {},
      listPortsFn: async () => fakePorts(['/dev/ttyTEST0', '/dev/ttyTEST1']),
      openSerialFn: (opts) => {
        current = openSerialFake(opts)
        return current
      },
      openGdbFn: () => {
        const ee = new EventEmitter()
        return {
          host: '127.0.0.1',
          port: 3333,
          close() {
            ee.emit('close')
          },
          write() {
            return true
          },
        }
      },
    },
  )
  try {
    await fn(bridge, () => current)
  } finally {
    await bridge.close()
  }
}

function connect(port, token = 'test-token') {
  const url = `ws://127.0.0.1:${port}/?token=${token}`
  const ws = new WebSocket(url)
  /** @type {Buffer[]} */
  const queue = []
  /** @type {((buf: Buffer) => void) | null} */
  let waiter = null
  ws.on('message', (data) => {
    const buf = Buffer.from(data)
    if (waiter) {
      const w = waiter
      waiter = null
      w(buf)
    } else {
      queue.push(buf)
    }
  })
  const next = () =>
    new Promise((resolve) => {
      if (queue.length) resolve(queue.shift())
      else waiter = resolve
    })
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next }))
    ws.once('error', reject)
  })
}

async function waitFrame(session, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const buf = await Promise.race([
      session.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for frame')), remaining)),
    ])
    const frame = decodeFrame(buf)
    if (frame && predicate(frame)) return frame
  }
  throw new Error('timeout waiting for frame')
}

test('rejects bad token with 4001', async () => {
  await withBridge(async (bridge) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/?token=nope`)
    const code = await new Promise((resolve) => {
      ws.on('close', (c) => resolve(c))
    })
    assert.equal(code, CLOSE_UNAUTHORIZED)
  })
})

test('hello lists ports; select-serial streams CTF', async () => {
  await withBridge(async (bridge, getSerial) => {
    const session = await connect(bridge.port)
    const hello = await waitFrame(
      session,
      (f) => f.channel === CH_CTRL && decodeCtrl(f.payload).type === 'hello',
    )
    const msg = decodeCtrl(hello.payload)
    assert.equal(msg.type, 'hello')
    assert.equal(msg.ports.length, 2)

    session.ws.send(encodeCtrl({ type: 'select-serial', path: '/dev/ttyTEST0', baudRate: 115200 }))
    await waitFrame(
      session,
      (f) =>
        f.channel === CH_CTRL &&
        decodeCtrl(f.payload).type === 'serial-status' &&
        decodeCtrl(f.payload).phase === 'streaming',
    )

    const serial = getSerial()
    assert.ok(serial)
    const ctfWait = waitFrame(session, (f) => f.channel === CH_CTF)
    serial._push(Buffer.from([0xaa, 0xbb, 0xcc]))
    const ctf = await ctfWait
    assert.deepEqual([...ctf.payload], [0xaa, 0xbb, 0xcc])

    session.ws.close()
  })
})

test('healthz reports ok', async () => {
  await withBridge(async (bridge) => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/healthz`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.ports.length, 2)
  })
})
