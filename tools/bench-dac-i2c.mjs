/**
 * Pure-JS microbench of the DAC I²C hot path (no QEMU).
 *
 *   node tools/bench-dac-i2c.mjs
 */
import { performance } from 'node:perf_hooks'
import { createI2cModel } from '../src/virtio/devices/i2c.ts'
import { createMcp4725 } from '../src/virtio/devices/chips/mcp4725.ts'
import { createDacHistory } from '../src/virtio/devices/dac/model.ts'

function bench(name, n, fn) {
  const t0 = performance.now()
  fn()
  const ms = performance.now() - t0
  const per = ms / n
  const hz = n / (ms / 1000)
  console.log(
    `${name.padEnd(42)} ${n.toString().padStart(7)} iters  ${ms.toFixed(1).padStart(8)} ms  ` +
      `${per.toFixed(4).padStart(8)} ms/op  ${hz.toFixed(0).padStart(10)} Hz`,
  )
  return { ms, hz }
}

const N = 30_000

{
  let t = 0
  const history = createDacHistory({ channelCount: 1, retentionMs: 30_000, now: () => t })
  bench('dac history.push 30k @1kHz', N, () => {
    for (let i = 0; i < N; i++) {
      t = i
      history.push(0, i & 0xfff, (i & 0xfff) / 4095)
    }
  })
  const view = history.view(0)
  bench('dac history.view lowerBound+walk', 1_000, () => {
    for (let k = 0; k < 1_000; k++) {
      const t0 = view.at(view.length - 1).t - 10_000
      const first = Math.max(0, view.lowerBound(t0) - 1)
      let sum = 0
      const step = Math.max(1, Math.floor((view.length - first) / 800))
      for (let i = first; i < view.length; i += step) sum += view.at(i).volts
      if (sum < 0) throw new Error('unreachable')
    }
  })
}

{
  const i2c = createI2cModel()
  const chip = createMcp4725({ address: 0x61 })
  i2c.attachChip(chip)
  // Fake VirtioRequest
  const makeReq = (payload) => {
    const out = new Uint8Array(8 + payload.length)
    const dv = new DataView(out.buffer)
    dv.setUint16(0, 0x61 << 1, true)
    dv.setUint32(4, 0, true)
    out.set(payload, 8)
    let answered = false
    return {
      queue: 0,
      out,
      inCap: 1,
      get answered() {
        return answered
      },
      reply() {
        answered = true
      },
      fail() {
        answered = true
      },
      park() {},
    }
  }
  bench('i2c handle + mcp4725 fast-write', N, () => {
    for (let i = 0; i < N; i++) {
      const hi = (i >> 8) & 0x0f
      const lo = i & 0xff
      i2c.handle(makeReq(Uint8Array.of(hi, lo)))
    }
  })
  console.log(`  log length=${i2c.transactions().length}  txCount=${i2c.transactionCount()}  code=${chip.getCode()}`)
}
