import type { PtyBackend, Slave, StartOptions } from './types'

/**
 * A tiny fake Zephyr shell.
 *
 * Exists so the terminal wiring, the status seam and the UI can be built and
 * demoed before any qemu-wasm artifact is available. It deliberately announces
 * itself in the banner — a fake boot log that is indistinguishable from a real
 * one would be a trap for whoever picks this up next.
 *
 * It leans on xterm-pty's default line discipline (ICANON | ECHO | ONLCR), so
 * echo, backspace and line assembly come for free and `slave.read()` yields one
 * complete line per Enter. The real Zephyr shell instead puts the tty in raw
 * mode and echoes itself, which is why qemuBackend does none of this.
 */

/** Bold green, matching what the real Zephyr shell emits. */
const PROMPT = '\x1b[1;32muart:~$ \x1b[m'

const BANNER = ['', '*** Booting Zephyr OS build v0.0.0-mock ***', '']

const HELP = [
  'Available commands:',
  '  clear    :Clear screen.',
  '  help     :Prints the help message.',
  '  history  :Command history.',
  '  kernel   :Kernel commands.',
  '  version  :Kernel version.',
]

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })

export function createMockBackend(): PtyBackend {
  let disposers: Array<() => void> = []

  const teardown = () => {
    for (const d of disposers) d()
    disposers = []
  }

  return {
    id: 'mock',
    label: 'Mock shell',
    resetRequiresReload: false,

    async start(slave: Slave, { onStatus, signal }: StartOptions) {
      teardown()
      onStatus({ status: 'loading', detail: 'starting mock' })

      // A short pause so the loading state is actually observable, and so the
      // banner reads like a boot rather than appearing all at once.
      await sleep(180, signal)
      if (signal.aborted) return

      for (const line of BANNER) {
        slave.write(`${line}\n`)
        await sleep(40, signal)
        if (signal.aborted) return
      }

      slave.write('\x1b[2m[mock backend — no QEMU running. See public/qemu/README.md]\x1b[0m\n\n')
      slave.write(PROMPT)
      onStatus({ status: 'running', detail: 'mock' })

      const run = (line: string) => {
        const [cmd, ...rest] = line.trim().split(/\s+/)
        switch (cmd) {
          case '':
            break
          case 'help':
            slave.write(`${HELP.join('\n')}\n`)
            break
          case 'version':
            slave.write('Zephyr version 0.0.0-mock\n')
            break
          case 'clear':
            // Clear screen + home cursor, same as the real shell's `clear`.
            slave.write('\x1b[2J\x1b[H')
            break
          case 'kernel':
            slave.write(
              rest[0] === 'version'
                ? 'Zephyr version 0.0.0-mock\n'
                : 'kernel - Kernel commands\nSubcommands:\n  version  :Kernel version.\n',
            )
            break
          default:
            slave.write(`${cmd}: command not found\n`)
        }
        slave.write(PROMPT)
      }

      const decoder = new TextDecoder()
      let pending = ''

      const onReadable = slave.onReadable(() => {
        pending += decoder.decode(Uint8Array.from(slave.read()), { stream: true })
        // Canonical mode hands us whole lines, but a paste can deliver several
        // at once, so drain every terminated line and keep any remainder.
        let nl: number
        while ((nl = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, nl)
          pending = pending.slice(nl + 1)
          run(line)
        }
      })

      const onSignal = slave.onSignal((sig) => {
        if (sig === 'SIGINT') {
          pending = ''
          slave.write(`\n${PROMPT}`)
        }
      })

      disposers.push(() => onReadable.dispose(), () => onSignal.dispose())
    },

    async reset() {
      teardown()
    },
  }
}
