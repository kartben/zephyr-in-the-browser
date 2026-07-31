import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CH_CTF,
  CH_CTRL,
  CH_GDB,
  CH_NET,
  decodeCtrl,
  decodeFrame,
  encodeCtrl,
  encodeFrame,
} from './protocol.mjs'

test('encode/decode round-trips CTF, GDB, and NET', () => {
  const ctf = encodeFrame(CH_CTF, Buffer.from([1, 2, 3]))
  const d = decodeFrame(ctf)
  assert.equal(d.channel, CH_CTF)
  assert.deepEqual([...d.payload], [1, 2, 3])

  const gdb = encodeFrame(CH_GDB, '$g#67')
  const g = decodeFrame(gdb)
  assert.equal(g.channel, CH_GDB)
  assert.equal(g.payload.toString('utf8'), '$g#67')

  const net = encodeFrame(CH_NET, Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  const n = decodeFrame(net)
  assert.equal(n.channel, CH_NET)
  assert.deepEqual([...n.payload], [0xde, 0xad, 0xbe, 0xef])
})

test('control JSON frames', () => {
  const frame = encodeCtrl({ type: 'hello', version: 1 })
  const d = decodeFrame(frame)
  assert.equal(d.channel, CH_CTRL)
  assert.deepEqual(decodeCtrl(d.payload), { type: 'hello', version: 1 })
})

test('empty buffer yields null', () => {
  assert.equal(decodeFrame(Buffer.alloc(0)), null)
})
