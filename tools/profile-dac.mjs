/**
 * Boot Cortex-A53 DAC under Chrome and measure I²C / scope pace.
 *
 *   npx playwright install chromium   # once
 *   node tools/profile-dac.mjs
 *
 * Reports i2cHz (want ~1000 for stock sawtooth), guest-virtual vs wall
 * advance, and how fast the MCP4725 code climbs — the chart "lags" when
 * wall throughput is far below 1 kHz or guest time stalls relative to code.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { decompose } from './profile-decompose.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5177
const APP_URL =
  `http://127.0.0.1:${PORT}/?board=qemu_cortex_a53&app=dac&backend=qemu&profile=1`

const wasm = path.join(root, 'public/qemu/qemu-system-aarch64.wasm')
const elf = path.join(root, 'public/qemu/zephyr/qemu_cortex_a53/dac.elf')
if (!existsSync(wasm) || !existsSync(elf)) {
  console.error('missing qemu assets — expected', wasm, 'and', elf)
  process.exit(1)
}

async function waitForServer(timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('vite dev server did not come up')
}

const vite = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BROWSER: 'none' },
})
let viteLog = ''
vite.stdout.on('data', (d) => {
  viteLog += d.toString()
})
vite.stderr.on('data', (d) => {
  viteLog += d.toString()
})

const browser = await chromium.launch({ headless: true })

try {
  await waitForServer()
  const page = await browser.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[page]', msg.text())
  })
  page.on('pageerror', (err) => console.error('[pageerror]', err.message))

  console.log('navigating', APP_URL)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })

  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated)
  console.log('crossOriginIsolated:', isolated)
  if (!isolated) throw new Error('page is not cross-origin isolated')

  console.log('waiting for MCP4725 traffic…')
  const readyAt = Date.now()
  for (;;) {
    if (Date.now() - readyAt > 180_000) throw new Error('timeout waiting for MCP4725')
    const ready = await page.evaluate(async () => {
      const virtio = await import('/src/virtio/index.ts')
      const stats = await import('/src/guestStats.ts')
      const chips = virtio.i2cModel.chips()
      const dac = chips.find((c) => c.address === 0x61 || c.decl?.name === 'MCP4725')
      if (!dac || typeof dac.getCode !== 'function') {
        return { ok: false, reason: 'no-dac', tx: virtio.i2cModel.transactionCount(), chips: chips.length }
      }
      if (virtio.i2cModel.transactionCount() < 10) {
        return { ok: false, reason: 'warming', tx: virtio.i2cModel.transactionCount(), chips: chips.length }
      }
      globalThis.__zephyrDac = dac
      globalThis.__zephyrI2c = virtio.i2cModel
      globalThis.__zephyrGuestNow = () => stats.guestVirtualNowMs()
      return {
        ok: true,
        tx: virtio.i2cModel.transactionCount(),
        code: dac.getCode(),
        guestMs: stats.guestVirtualNowMs(),
      }
    })
    if (ready.ok) {
      console.log('MCP4725 live', ready)
      break
    }
    if (ready.tx > 0 || ready.chips > 0) {
      process.stdout.write(`  … ${ready.reason} tx=${ready.tx} chips=${ready.chips}\n`)
    }
    await sleep(500)
  }

  let prev = await page.evaluate(() => {
    const dac = globalThis.__zephyrDac
    const i2c = globalThis.__zephyrI2c
    return {
      wall: performance.now(),
      code: dac.getCode(),
      gen: dac.version(),
      i2c: i2c.transactionCount(),
      hist: dac.getHistory(0).length,
      guestMs: globalThis.__zephyrGuestNow?.() ?? null,
    }
  })

  const rows = []
  const start = Date.now()
  while (Date.now() - start < 12_000) {
    await sleep(500)
    const snap = await page.evaluate(() => window.__zephyrProfile?.snapshot() ?? null)
    const cur = await page.evaluate(() => {
      const dac = globalThis.__zephyrDac
      const i2c = globalThis.__zephyrI2c
      return {
        wall: performance.now(),
        code: dac.getCode(),
        gen: dac.version(),
        i2c: i2c.transactionCount(),
        hist: dac.getHistory(0).length,
        guestMs: globalThis.__zephyrGuestNow?.() ?? null,
        volts: dac.getChannel(0).volts,
      }
    })
    const dt = (cur.wall - prev.wall) / 1000
    const writes = cur.gen - prev.gen
    const i2cDelta = cur.i2c - prev.i2c
    const guestDelta =
      cur.guestMs != null && prev.guestMs != null ? cur.guestMs - prev.guestMs : null
    const row = {
      t: (Date.now() - start) / 1000,
      codeHz: writes / dt,
      i2cHzMeas: i2cDelta / dt,
      guestMsPerSec: guestDelta != null ? guestDelta / dt : null,
      code: cur.code,
      volts: cur.volts,
      hist: cur.hist,
      profileI2cHz: snap?.i2cHz ?? null,
      bridgeHz: snap?.bridgeHz ?? null,
      bridgeWakeHz: snap?.bridgeWakeHz ?? null,
      bridgeWaiterActive: snap?.bridgeWaiterActive ?? null,
      bridgePollMs: snap?.bridgePollMs ?? null,
      mips: snap?.mips ?? null,
      wakeAvgNs: snap?.wakeAvgNs ?? null,
      wakeMaxNs: snap?.wakeMaxNs ?? null,
      wakeCount: snap?.wakeCount ?? null,
      rtAvgMs: snap?.i2cRoundTripAvgMs ?? null,
      rtMaxMs: snap?.i2cRoundTripMaxMs ?? null,
      rtCount: snap?.i2cRoundTripCount ?? null,
      rtSlowCount: snap?.i2cRoundTripSlowCount ?? null,
      serviceAvgMs: snap?.i2cServiceAvgMs ?? null,
      warpOvershootAvgNs: snap?.warpOvershootAvgNs ?? null,
      warpOvershootMaxNs: snap?.warpOvershootMaxNs ?? null,
      warpOvershootCount: snap?.warpOvershootCount ?? null,
      notifyViaKick: snap?.notifyViaKick ?? null,
      notifyViaTimer: snap?.notifyViaTimer ?? null,
      notes: snap?.notes ?? [],
    }
    rows.push(row)
    console.log(
      `  t=${row.t.toFixed(1)}s codeHz=${row.codeHz.toFixed(0)} i2cHz=${row.i2cHzMeas.toFixed(0)} ` +
        `guestMs/s=${row.guestMsPerSec?.toFixed?.(0) ?? '-'} hist=${row.hist} ` +
        `bridgeHz=${row.bridgeHz?.toFixed?.(0) ?? '-'} wakeHz=${row.bridgeWakeHz?.toFixed?.(0) ?? '-'} ` +
        `waiter=${row.bridgeWaiterActive ?? '-'} pollMs=${row.bridgePollMs?.toFixed?.(2) ?? '-'} ` +
        `mips=${row.mips?.toFixed?.(1) ?? '-'} code=${row.code} ` +
        `rtAvgMs=${row.rtAvgMs != null ? row.rtAvgMs.toFixed(3) : '-'} ` +
        `svcAvgMs=${row.serviceAvgMs != null ? row.serviceAvgMs.toFixed(3) : '-'} ` +
        `wakeAvgMs=${row.wakeAvgNs != null ? (row.wakeAvgNs / 1e6).toFixed(2) : '-'} ` +
        `wakeMaxMs=${row.wakeMaxNs != null ? (row.wakeMaxNs / 1e6).toFixed(2) : '-'} ` +
        `wakeN=${row.wakeCount ?? '-'} ` +
        `warpAvgMs=${row.warpOvershootAvgNs != null ? (row.warpOvershootAvgNs / 1e6).toFixed(2) : '-'} ` +
        `warpMaxMs=${row.warpOvershootMaxNs != null ? (row.warpOvershootMaxNs / 1e6).toFixed(2) : '-'} ` +
        `warpN=${row.warpOvershootCount ?? '-'} ` +
        `viaKick=${row.notifyViaKick ?? '-'} viaTimer=${row.notifyViaTimer ?? '-'}`,
    )
    prev = cur
  }

  const steady = rows.slice(Math.floor(rows.length / 3))
  const avg = (key) => {
    const vals = steady.map((r) => r[key]).filter((v) => v != null && Number.isFinite(v))
    return vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)
  }

  console.log('\n=== dac profile (steady-state) ===')
  console.log(
    JSON.stringify(
      {
        codeHz: +avg('codeHz').toFixed(1),
        i2cHz: +avg('i2cHzMeas').toFixed(1),
        guestMsPerWallSec: +avg('guestMsPerSec').toFixed(1),
        bridgeHz: +avg('bridgeHz').toFixed(1),
        bridgeWakeHz: +avg('bridgeWakeHz').toFixed(1),
        bridgeWaiterActive: rows.at(-1)?.bridgeWaiterActive ?? null,
        bridgePollMs: +avg('bridgePollMs').toFixed(2),
        mips: +avg('mips').toFixed(1),
        // The decomposition item 15 exists for. periodMs is what one transfer
        // costs end to end; roundTrip is the browser's share of it, service
        // the device model's share of that, and hop the two cross-thread
        // hops — the only part moving models into wasm could remove.
        //
        // An emulator without 0018 reports -1, and the derived fields go null
        // rather than to a plausible-looking 0: "not measured" and "free" are
        // the two answers this whole exercise exists to tell apart.
        ...decompose(avg('i2cHzMeas'), avg('rtAvgMs'), avg('serviceAvgMs')),
        roundTripMaxMs: avg('rtMaxMs') >= 0 ? +avg('rtMaxMs').toFixed(3) : null,
        roundTripSlowCount: rows.at(-1)?.rtSlowCount ?? null,
        wakeAvgMs: +(avg('wakeAvgNs') / 1e6).toFixed(2),
        wakeMaxMs: +(avg('wakeMaxNs') / 1e6).toFixed(2),
        warpOvershootAvgMs: +(avg('warpOvershootAvgNs') / 1e6).toFixed(2),
        warpOvershootMaxMs: +(avg('warpOvershootMaxNs') / 1e6).toFixed(2),
        notifyViaKick: rows.at(-1)?.notifyViaKick ?? null,
        notifyViaTimer: rows.at(-1)?.notifyViaTimer ?? null,
        expectedCodeHz: 1000,
        periodWallSecAtMeasured: +(4096 / Math.max(1, avg('codeHz'))).toFixed(1),
        notes: [...new Set(steady.flatMap((r) => r.notes))],
        last: rows.at(-1),
      },
      null,
      2,
    ),
  )
} catch (err) {
  console.error('PROFILE FAILED:', err)
  console.error('--- vite log (tail) ---')
  console.error(viteLog.slice(-6000))
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
  vite.kill('SIGTERM')
}
