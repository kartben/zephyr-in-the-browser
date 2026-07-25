/**
 * Why src/virtio/transport.ts arms its hot-path timer from a MessagePort
 * handler instead of from the previous timer's callback.
 *
 *   node tools/probe-timer-clamp.mjs
 *   CHROME_PATH=/path/to/chrome node tools/probe-timer-clamp.mjs
 *
 * A browser derives a timer's *nesting level* from the task that scheduled it,
 * and clamps the delay to 4 ms once that level passes 5. A loop that
 * reschedules itself with `setTimeout(tick, 1)` from inside `tick` therefore
 * asks for 1 ms and is given 4, for as long as it keeps running. A task started
 * by `postMessage` sits at nesting level 0, so arming the same timer from there
 * is honoured.
 *
 * This matters here because the guest *blocks* on the page for every virtio
 * request, so the bridge's poll period is added to the latency of every I2C
 * transfer the guest makes. Measured in Chromium 1194:
 *
 *   nested  mean 3.87 ms  median 4.10 ms  steady-state 4.18 ms
 *   port    mean 1.16 ms  median 1.10 ms  steady-state 1.17 ms
 */
import { chromium } from 'playwright'

const ITERATIONS = 60
/** Skip the run-up: the clamp needs five levels of nesting to bite. */
const WARMUP = 10

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
)
const page = await browser.newPage()
await page.setContent('<!doctype html><title>timer clamp probe</title>')

const measure = (mode) =>
  page.evaluate(
    ([mode, iterations, warmup]) =>
      new Promise((resolve) => {
        const gaps = []
        let last = performance.now()
        let n = 0
        const chan = new MessageChannel()

        const tick = () => {
          const now = performance.now()
          gaps.push(now - last)
          last = now
          if (++n >= iterations) {
            const sorted = [...gaps].sort((a, b) => a - b)
            const steady = gaps.slice(warmup)
            resolve({
              mean: gaps.reduce((a, b) => a + b, 0) / gaps.length,
              median: sorted[sorted.length >> 1],
              steady: steady.reduce((a, b) => a + b, 0) / Math.max(1, steady.length),
            })
            return
          }
          schedule()
        }

        // nested: reschedule straight from the timer callback.
        // port:   post a message and arm the timer from *that* task instead.
        const schedule =
          mode === 'nested' ? () => setTimeout(tick, 1) : () => chan.port2.postMessage(0)
        chan.port1.onmessage = () => setTimeout(tick, 1)
        chan.port1.start()

        schedule()
      }),
    [mode, ITERATIONS, WARMUP],
  )

for (const mode of ['nested', 'port']) {
  const r = await measure(mode)
  console.log(
    `${mode.padEnd(7)} mean ${r.mean.toFixed(2)} ms  median ${r.median.toFixed(2)} ms  ` +
      `steady-state ${r.steady.toFixed(2)} ms`,
  )
}

await browser.close()
