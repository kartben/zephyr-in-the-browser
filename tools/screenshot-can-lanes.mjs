/**
 * Paint the real CAN arbitration lane renderer into a canvas and screenshot it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173
 *   node tools/screenshot-can-lanes.mjs [suffix]
 *
 * Writes PNGs under /opt/cursor/artifacts/screenshots/.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const OUT = '/opt/cursor/artifacts/screenshots'
const BASE = process.env.CAN_SHOT_URL ?? 'http://127.0.0.1:5173'
const SUFFIX = process.argv[2] ?? 'shot'

mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
})

const page = await browser.newPage()
await page.setViewport({ width: 720, height: 520, deviceScaleFactor: 2 })
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })

await page.evaluate(() => {
  document.body.innerHTML = `
    <div id="wrap" style="padding:16px;width:400px;background:#0c0e12">
      <h1 id="title" style="color:#9aa3b2;font:12px ui-sans-serif,system-ui;margin:0 0 8px">CAN arbitration lanes</h1>
      <canvas id="c" style="display:block;width:368px;border:1px solid #2a2e36;border-radius:6px"></canvas>
    </div>
  `
})

const paintInfo = await page.evaluate(async (kind) => {
  const { createCanBus } = await import('/src/can/bus.ts')
  const { buildLaneModel, livePinnedView, paintArbitrationLanes } = await import(
    '/src/components/CanArbitrationLanes.ts'
  )

  const frame = (id, data = [1]) => ({
    id,
    ext: false,
    rtr: false,
    data: Uint8Array.from(data),
  })

  function scenarioArbitration() {
    let t = 1000
    const bus = createCanBus(() => t)
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'periodic', name: 'Periodic' })
    bus.attach({ id: 'responder', name: 'Responder' })

    bus.send('periodic', frame(0x0a0, [0]))
    t += 280
    bus.pump(t)
    bus.send('periodic', frame(0x0a0, [1]))
    t += 280
    bus.pump(t)

    bus.send('periodic', frame(0x0a0, [2]))
    bus.send('responder', frame(0x200, [9]))
    bus.send('can0', frame(0x100, [3]))
    t += 10
    bus.pump(t)
    t += 10
    bus.pump(t)

    bus.send('can0', frame(0x100, [4]))
    t += 320
    bus.pump(t)
    bus.send('responder', frame(0x200, [8]))
    t += 320
    bus.pump(t)

    return { nodes: bus.nodes(), log: bus.log(), tip: t, windowMs: 2000 }
  }

  function scenarioMixedIds() {
    let t = 0
    const bus = createCanBus(() => t)
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'peer', name: 'Peer' })
    for (const id of [0x100, 0x7ff, 0x010, 0x100, 0x2aa]) {
      bus.send('peer', frame(id, [1]))
      t += 280
      bus.pump(t)
    }
    bus.send('can0', frame(0x001, [2]))
    t += 280
    bus.pump(t)
    return { nodes: bus.nodes(), log: bus.log(), tip: t, windowMs: 2000 }
  }

  function scenarioDense() {
    let t = 0
    const bus = createCanBus(() => t)
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'peer', name: 'Peer' })
    for (let i = 0; i < 24; i++) {
      bus.send('peer', frame(0x0a0 + (i % 3), [i]))
      t += 40
      bus.pump(t)
    }
    return { nodes: bus.nodes(), log: bus.log(), tip: t, windowMs: 2000 }
  }

  window.__scenarios = { arb: scenarioArbitration, mixed: scenarioMixedIds, dense: scenarioDense }
  window.__paintMods = { buildLaneModel, livePinnedView, paintArbitrationLanes }

  const run = window.__scenarios[kind]
  const { nodes, log, tip, windowMs } = run()
  const canvas = document.getElementById('c')
  const model = buildLaneModel(nodes, log, livePinnedView(tip, windowMs))
  paintArbitrationLanes(
    canvas,
    model,
    {
      bg: '#0c0e12',
      muted: 'rgba(255,255,255,0.45)',
      faint: 'rgba(255,255,255,0.07)',
      live: 'rgba(34, 197, 94, 0.95)',
    },
    true,
  )
  document.getElementById('title').textContent =
    kind === 'mixed'
      ? 'Same peer, mixed frame IDs'
      : kind === 'dense'
        ? 'Dense traffic (labels when there is room)'
        : 'Arbitration (0x200 loses to 0x100)'
  return {
    ticks: model.ticks.map((t) => ({ nodeId: t.nodeId, frameId: t.frameId, lost: t.lost })),
    lanes: model.lanes.map((l) => ({ name: l.name })),
  }
}, 'arb')

console.log('arb', JSON.stringify(paintInfo))
await new Promise((r) => setTimeout(r, 50))
await (await page.$('#wrap')).screenshot({ path: join(OUT, `can-lanes-arb-${SUFFIX}.png`) })
console.log('wrote', join(OUT, `can-lanes-arb-${SUFFIX}.png`))

for (const kind of ['mixed', 'dense']) {
  const info = await page.evaluate((k) => {
    const { buildLaneModel, livePinnedView, paintArbitrationLanes } = window.__paintMods
    const { nodes, log, tip, windowMs } = window.__scenarios[k]()
    const canvas = document.getElementById('c')
    const model = buildLaneModel(nodes, log, livePinnedView(tip, windowMs))
    paintArbitrationLanes(
      canvas,
      model,
      {
        bg: '#0c0e12',
        muted: 'rgba(255,255,255,0.45)',
        faint: 'rgba(255,255,255,0.07)',
        live: 'rgba(34, 197, 94, 0.95)',
      },
      true,
    )
    document.getElementById('title').textContent =
      k === 'mixed'
        ? 'Same peer, mixed frame IDs'
        : k === 'dense'
          ? 'Dense traffic (labels when there is room)'
          : 'Arbitration (0x200 loses to 0x100)'
    return {
      ticks: model.ticks.map((t) => ({ nodeId: t.nodeId, frameId: t.frameId, lost: t.lost })),
      lanes: model.lanes.map((l) => ({ name: l.name })),
    }
  }, kind)

  console.log(kind, JSON.stringify(info))
  await new Promise((r) => setTimeout(r, 50))
  const path = join(OUT, `can-lanes-${kind}-${SUFFIX}.png`)
  await (await page.$('#wrap')).screenshot({ path })
  console.log('wrote', path)
}

await browser.close()
