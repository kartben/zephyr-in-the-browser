#!/usr/bin/env node
/**
 * CLI entry: start the probe bridge and (when stdin is a TTY) the TUI.
 *
 *   node cli.mjs
 *   SERIAL=/dev/ttyACM0 BAUD=115200 node cli.mjs
 *   NO_TUI=1 node cli.mjs
 */

import { pathToFileURL } from 'node:url'
import { ConfigError, configFromEnv, startProbeBridge } from './server.mjs'
import { runTui } from './tui.mjs'

async function main() {
  let cfg
  try {
    cfg = configFromEnv()
  } catch (error) {
    console.error(error.message)
    process.exit(error instanceof ConfigError ? 2 : 1)
  }

  let bridge
  try {
    bridge = await startProbeBridge(cfg)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

  const shutdown = () => {
    bridge.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (cfg.noTui || !process.stdin.isTTY) {
    // Banner already printed by startProbeBridge; stay alive.
    await new Promise(() => {})
    return
  }

  const deepLink = `${cfg.pagesUrl}?probe=${encodeURIComponent(bridge.wsUrl)}`
  await runTui({
    bridge,
    wsUrl: bridge.wsUrl,
    deepLink,
    baudRate: cfg.baudRate,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
