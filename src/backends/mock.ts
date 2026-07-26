import type { PtyBackend, Slave, StartOptions } from './types'
import { sampleAnnotationsAsset, sampleDtsAsset } from '@/boards'
import { loadSampleDts } from '@/devicetree'
import { get as getGuestImage } from '@/guestImage'
import { attach as attachHostGnss, detach as detachHostGnss } from '@/hostGnss'
import { attach as attachHostNet, detach as detachHostNet } from '@/hostNet'
import { createFakeNetModule } from '@/net/testing/fakeModule'
import { FakeGuest } from '@/net/testing/fakeGuest'
import { startMockWalkthrough } from './mockWalkthrough'

/**
 * A tiny fake Zephyr shell.
 *
 * Uses xterm-pty's default line discipline; the real Zephyr shell runs raw and
 * echoes itself, so qemuBackend does not do this.
 */

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

    async start(slave: Slave, { board, sampleId, onStatus, signal }: StartOptions) {
      teardown()
      onStatus({ status: 'loading', detail: 'starting mock' })

      // Same devicetree side-channel as the real backend.
      if (!getGuestImage()) {
        void loadSampleDts(
          `${import.meta.env.BASE_URL}qemu/${sampleDtsAsset(board, sampleId)}`,
          `${sampleId}.dts`,
        )
      }

      // Briefly show loading before the fake boot log appears.
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
        // A paste can deliver several canonical lines at once.
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

      // Fake guest uses the same rings/stack/TCP engine as the real network panel path.
      if (board.peripherals?.hostNet) startFakeNetwork(disposers)

      if (board.peripherals?.gnss) {
        attachHostGnss({ _qemu_browser_gnss_feed_byte: () => 0 })
        disposers.push(() => detachHostGnss())
      }

      disposers.push(
        startMockWalkthrough(
          slave,
          `${import.meta.env.BASE_URL}qemu/${sampleAnnotationsAsset(board, sampleId)}`,
          signal,
        ),
      )
    },

    async reset() {
      teardown()
    },
  }
}

/** Scripted fake guest for the Network panel tools. */
function startFakeNetwork(disposers: Array<() => void>) {
  const fake = createFakeNetModule()
  attachHostNet(fake.module)

  const guest = new FakeGuest({
    sendFrame: (frame) => {
      if (fake.guestSide.linkUp()) fake.guestSide.writeTx(frame)
    },
    now: () => Date.now(),
    random: Math.random,
  })
  guest.serveHttp(8080, MOCK_GUEST_PAGE)
  guest.echoServer(4242)

  const rxPoll = setInterval(() => {
    for (const frame of fake.guestSide.drainRx()) guest.onFrame(frame)
    guest.tick()
  }, 30)

  const timers: Array<ReturnType<typeof setTimeout>> = []
  let seq = 1
  const boot = setTimeout(() => {
    void guest.dhcp().then(() => {
      timers.push(setInterval(() => void guest.ping('192.0.2.2', seq++).catch(() => {}), 2500))
      timers.push(setInterval(() => void guest.httpGet('host.internal', '/').catch(() => {}), 9000))
    })
  }, 700)

  disposers.push(() => {
    clearTimeout(boot)
    clearInterval(rxPoll)
    for (const t of timers) clearInterval(t)
    detachHostNet()
  })
}

const MOCK_GUEST_PAGE = [
  '<!doctype html>',
  '<title>mock guest</title>',
  '<h1>Hello from the (mock) guest!</h1>',
  '<p>This page was served over the in-page TCP/IP stack.</p>',
  '',
].join('\n')
