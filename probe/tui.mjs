/**
 * Compact full-screen TUI for the probe bridge.
 *
 * No extra deps: alternate screen + raw stdin. Survives serial unplug; the
 * process stays up until q / Ctrl-C.
 */

import { fmtBytes } from './server.mjs'

const ESC = '\x1b'
const HIDE = `${ESC}[?25l`
const SHOW = `${ESC}[?25h`
const ALT_ON = `${ESC}[?1049h`
const ALT_OFF = `${ESC}[?1049l`
const CLEAR = `${ESC}[2J${ESC}[H`
const DIM = `${ESC}[2m`
const RESET = `${ESC}[0m`
const BOLD = `${ESC}[1m`
const GREEN = `${ESC}[32m`
const YELLOW = `${ESC}[33m`
const RED = `${ESC}[31m`
const CYAN = `${ESC}[36m`

/**
 * @param {{
 *   bridge: Awaited<ReturnType<import('./server.mjs').startProbeBridge>>,
 *   wsUrl: string,
 *   deepLink: string,
 *   baudRate: number,
 *   input?: NodeJS.ReadStream,
 *   output?: NodeJS.WriteStream,
 * }} opts
 */
export async function runTui(opts) {
  const {
    bridge,
    wsUrl,
    deepLink,
    baudRate,
    input = process.stdin,
    output = process.stdout,
  } = opts

  if (!input.isTTY || !output.isTTY) {
    return runHeadless(bridge)
  }

  let selected = 0
  let help = false
  let lastErr = ''
  /** @type {ReturnType<typeof bridge.snapshot>} */
  let snap = bridge.snapshot()

  const unsub = bridge.subscribeStatus((s) => {
    snap = s
    // Keep selection in range as ports hot-plug.
    if (selected >= snap.ports.length) selected = Math.max(0, snap.ports.length - 1)
    draw()
  })

  const draw = () => {
    const lines = []
    lines.push(`${BOLD}Zephyr probe bridge${RESET}  ${DIM}v${snap.version}${RESET}`)
    lines.push('')
    lines.push(`${CYAN}WebSocket${RESET}  ${wsUrl}`)
    lines.push(`${CYAN}Open${RESET}       ${deepLink}`)
    lines.push('')
    lines.push(
      `${BOLD}Serial ports${RESET}  ${DIM}(↑↓ select · enter stream · s stop · r refresh)${RESET}`,
    )

    if (snap.ports.length === 0) {
      lines.push(`  ${DIM}No serial ports yet. Plug in a board or probe.${RESET}`)
    } else {
      for (let i = 0; i < snap.ports.length; i++) {
        const p = snap.ports[i]
        const active = snap.serial.path === p.path && snap.serial.phase === 'streaming'
        const cursor = i === selected ? '›' : ' '
        const mark = active ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`
        const label = `${p.path}  ${DIM}${p.friendlyName}${RESET}`
        lines.push(`  ${cursor} ${mark} ${label}`)
      }
    }

    lines.push('')
    const phaseColor =
      snap.serial.phase === 'streaming' ? GREEN : snap.serial.phase === 'error' ? RED : DIM
    lines.push(
      `${BOLD}CTF${RESET}   ${phaseColor}${snap.serial.phase}${RESET}` +
        (snap.serial.path ? `  ${snap.serial.path} @ ${snap.serial.baudRate}` : '') +
        (snap.serial.detail ? `  ${DIM}${snap.serial.detail}${RESET}` : '') +
        `  ${DIM}${fmtBytes(snap.ctfBytes)}${RESET}`,
    )
    const gdbColor =
      snap.gdb.phase === 'connected' ? GREEN : snap.gdb.phase === 'error' ? RED : DIM
    lines.push(
      `${BOLD}GDB${RESET}   ${gdbColor}${snap.gdb.phase}${RESET}  ${snap.gdb.host}:${snap.gdb.port}` +
        (snap.gdb.detail ? `  ${DIM}${snap.gdb.detail}${RESET}` : '') +
        `  ${DIM}${fmtBytes(snap.gdbBytes)}${RESET}`,
    )
    lines.push(
      `${BOLD}Clients${RESET}  ${snap.clients}/${snap.maxClients}`,
    )
    if (lastErr) lines.push(`${RED}${lastErr}${RESET}`)
    lines.push('')
    if (help) {
      lines.push(`${YELLOW}Keys${RESET}`)
      lines.push('  enter  stream CTF from the selected port')
      lines.push('  s      stop serial stream')
      lines.push('  g      attach GDB proxy (OpenOCD / J-Link on host:port)')
      lines.push('  G      detach GDB')
      lines.push('  r      refresh port list')
      lines.push('  ?      toggle this help')
      lines.push('  q      quit (Ctrl-C also works)')
      lines.push('')
    }
    lines.push(
      `${DIM}[?] help  [g] GDB  [q] quit · daemon stays up if you only unplug the board${RESET}`,
    )

    output.write(CLEAR + HIDE + lines.join('\n') + '\n')
  }

  const onKey = (buf) => {
    const s = buf.toString('utf8')
    if (s === '\u0003' || s === 'q' || s === 'Q') {
      cleanup()
      bridge.close().then(() => process.exit(0))
      return
    }
    if (s === '?' || s === 'h') {
      help = !help
      draw()
      return
    }
    if (s === 'r' || s === 'R') {
      void bridge.refreshPorts()
      return
    }
    if (s === 's' || s === 'S') {
      bridge.stopSerial()
      lastErr = ''
      return
    }
    if (s === 'g') {
      try {
        bridge.attachGdb()
        lastErr = ''
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err)
        draw()
      }
      return
    }
    if (s === 'G') {
      bridge.detachGdb()
      return
    }
    // arrows: ESC [ A/B
    if (s === '\u001b[A' || s === 'k') {
      selected = Math.max(0, selected - 1)
      draw()
      return
    }
    if (s === '\u001b[B' || s === 'j') {
      selected = Math.min(Math.max(0, snap.ports.length - 1), selected + 1)
      draw()
      return
    }
    if (s === '\r' || s === '\n') {
      const p = snap.ports[selected]
      if (!p) {
        lastErr = 'No port selected'
        draw()
        return
      }
      lastErr = ''
      bridge.selectSerial(p.path, baudRate)
    }
  }

  const cleanup = () => {
    unsub()
    input.off('data', onKey)
    if (input.isTTY) {
      try {
        input.setRawMode(false)
      } catch {
        /* */
      }
    }
    input.pause()
    output.write(SHOW + ALT_OFF)
  }

  output.write(ALT_ON + HIDE)
  input.setRawMode(true)
  input.resume()
  input.on('data', onKey)
  draw()

  await new Promise(() => {
    /* runs until quit */
  })
}

async function runHeadless(bridge) {
  bridge.subscribeStatus((snap) => {
    const ser =
      snap.serial.phase === 'streaming'
        ? `${snap.serial.path} streaming ${fmtBytes(snap.ctfBytes)}`
        : snap.serial.phase
    console.log(
      `[probe] status clients=${snap.clients} serial=${ser} gdb=${snap.gdb.phase} ports=${snap.ports.length}`,
    )
  })
  await new Promise(() => {})
}
