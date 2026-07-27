import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as monitor from '@/hostMonitor'
import { resetForTests as resetPoll } from '@/hostPoll'

beforeEach(() => {
  vi.useFakeTimers()
  monitor.resetForTests()
  resetPoll()
})

afterEach(() => {
  monitor.resetForTests()
  resetPoll()
  vi.useRealTimers()
})

describe('hostMonitor debug', () => {
  it('hides until a bridge is attached', () => {
    expect(monitor.getSnapshot()).toMatchObject({ available: false, paused: false })
  })

  it('loads registers when the stub pauses', async () => {
    monitor.attachStub('R15=00001234\n')
    expect(monitor.getSnapshot().available).toBe(true)

    monitor.pause()
    await Promise.resolve()
    await Promise.resolve()

    expect(monitor.getSnapshot().paused).toBe(true)
    expect(monitor.getSnapshot().pc).toBe('00001234')
    expect(monitor.getSnapshot().summary).toBe('PC 00001234')
    expect(monitor.getSnapshot().registers).toContain('R15=00001234')
  })

  it('clears registers on resume', async () => {
    monitor.attachStub('R15=00001234\n')
    monitor.pause()
    await Promise.resolve()
    await Promise.resolve()
    expect(monitor.getSnapshot().pc).toBe('00001234')

    monitor.resume()
    expect(monitor.getSnapshot()).toMatchObject({
      paused: false,
      pc: null,
      summary: null,
      registers: null,
    })
  })

  it('advances the stub PC on step', async () => {
    monitor.attachStub('R15=00001000\n')
    monitor.pause()
    await Promise.resolve()
    await Promise.resolve()
    expect(monitor.getSnapshot().pc).toBe('00001000')

    await monitor.step()
    expect(monitor.getSnapshot().pc).toBe('00001002')
  })

  it('matches QMP replies by id over the ring', async () => {
    const ringSize = 256
    const heap = new Uint8Array(ringSize + 64)
    let readIndex = 0
    let writeIndex = 0
    const fed: number[] = []

    const pushLine = (line: string) => {
      for (const ch of `${line}\n`) {
        heap[writeIndex % ringSize] = ch.charCodeAt(0)
        writeIndex = (writeIndex + 1) >>> 0
      }
    }

    monitor.attach({
      _qemu_browser_monitor_feed: (value: number) => {
        fed.push(value)
        return 0
      },
      _qemu_browser_monitor_ring: () => 0,
      _qemu_browser_monitor_ring_size: () => ringSize,
      _qemu_browser_monitor_read_index: () => readIndex,
      _qemu_browser_monitor_write_index: () => writeIndex,
      _qemu_browser_monitor_set_read_index: (value: number) => {
        readIndex = value
      },
      HEAPU8: heap,
    })

    // Greeting + capabilities path.
    pushLine(JSON.stringify({ QMP: { version: { qemu: { major: 9 } } } }))
    await vi.advanceTimersByTimeAsync(100)

    // Pretend query-status said running.
    pushLine(JSON.stringify({ return: { running: true, status: 'running' } }))
    await vi.advanceTimersByTimeAsync(100)
    expect(monitor.getSnapshot().paused).toBe(false)

    monitor.pause()
    const stopText = String.fromCharCode(...fed)
    expect(stopText).toContain('"execute":"stop"')

    pushLine(JSON.stringify({ event: 'STOP' }))
    await vi.advanceTimersByTimeAsync(100)
    // refreshRegisters sends after the STOP handler yields to microtasks.
    await Promise.resolve()
    await Promise.resolve()

    const fedText = String.fromCharCode(...fed)
    expect(fedText).toContain('info registers')
    const commands = fedText
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { execute?: string; id?: string }
        } catch {
          return null
        }
      })
      .filter((cmd): cmd is { execute?: string; id?: string } => cmd !== null)
    const regsCmd = commands.find((cmd) => cmd.execute === 'human-monitor-command')
    expect(regsCmd?.id).toBeTruthy()
    const id = regsCmd!.id!

    pushLine(
      JSON.stringify({
        return: 'R15=0000beef XPSR=00000000\n',
        id,
      }),
    )
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()
    await Promise.resolve()

    expect(monitor.getSnapshot().pc).toBe('0000beef')
    expect(monitor.getSnapshot().registersLoading).toBe(false)
  })
})
