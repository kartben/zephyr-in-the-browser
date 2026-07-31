/**
 * Run control against a stub that behaves the way QEMU's actually does.
 *
 * The freeze these tests pin down was not a logic slip in the client — it was
 * the client assuming the stub buffers whatever it is sent. It does not.
 * `gdb_read_byte()` in gdbstub/gdbstub.c short-circuits while the vCPU runs:
 *
 *     if (runstate_is_running()) {
 *         if (ch != 0x03) { trace_gdbstub_err_unexpected_runpkt(ch); }
 *         else { gdbserver_state.allow_stop_reply = true; }
 *         vm_stop(RUN_STATE_PAUSED);
 *     }
 *
 * So a byte that is not `0x03` stops the machine *and says nothing about it*,
 * and a `0x03` that arrives when the machine is already stopped falls through
 * to the packet parser, which discards it as garbage. {@link FakeStub} models
 * exactly those two rules; everything below is a consequence of them.
 */

import { describe, expect, it } from 'vitest'
import { RspClient } from '@/debug/gdb/rspClient'
import { chardevRspTransport } from '@/debug/gdb/rspTransport'
import { encodePacket } from '@/debug/gdb/rspCodec'
import type { ChardevExports } from '@/debug/browserChardev'

class FakeStub {
  /** Bytes QEMU has produced for the page. */
  private out = ''
  /** Partial `$…#cs` from the page. */
  private inBuf = ''
  running = false
  /** Stops caused by a stray byte rather than by a deliberate halt. */
  silentStops = 0
  /** `0x03` bytes that halted a running machine, i.e. produced a stop reply. */
  breaks = 0
  /** `0x03` bytes the stopped stub threw away — the ones nothing ever answers. */
  discardedBreaks = 0
  packets: string[] = []

  private reply(payload: string) {
    this.out += encodePacket(payload)
  }

  /** One byte page → QEMU, following gdb_read_byte(). */
  feed(byte: number): number {
    if (this.running) {
      this.running = false
      if (byte === 0x03) {
        this.breaks++
        this.reply('T02thread:p01.01;')
      } else {
        this.silentStops++ // vm_stop() with allow_stop_reply == false
      }
      return 0
    }
    // Stopped: ordinary packet parsing. A bare 0x03 here is garbage.
    const ch = String.fromCharCode(byte)
    if (this.inBuf === '' && ch !== '$') {
      if (byte === 0x03) this.discardedBreaks++
      return 0
    }
    this.inBuf += ch
    const hash = this.inBuf.indexOf('#')
    if (hash < 0 || this.inBuf.length < hash + 3) return 0
    const payload = this.inBuf.slice(1, hash)
    this.inBuf = ''
    this.packets.push(payload)
    this.answer(payload)
    return 0
  }

  private answer(payload: string) {
    if (payload.startsWith('qSupported')) this.reply('PacketSize=1000;QStartNoAckMode+')
    else if (payload === 'QStartNoAckMode') this.reply('OK')
    else if (payload === '?') this.reply('T05thread:p01.01;')
    else if (payload === 'vCont;c') this.running = true
    else if (payload === 'vCont;s') this.reply('T05thread:p01.01;')
    else if (payload.startsWith('m')) this.reply('00112233')
    else if (payload.startsWith('Z0') || payload.startsWith('z0')) this.reply('OK')
    else this.reply('')
  }

  /** The six chardev exports the client binds to. */
  exports(): ChardevExports {
    const heap = new Uint8Array(1 << 16)
    let read = 0
    let write = 0
    const flush = () => {
      for (const c of this.out) heap[write++ % heap.length] = c.charCodeAt(0) & 0xff
      this.out = ''
    }
    return {
      feed: (v: number) => this.feed(v),
      ring: () => 0,
      ringSize: () => heap.length,
      readIndex: () => read,
      writeIndex: () => (flush(), write),
      setReadIndex: (v: number) => {
        read = v
      },
      HEAPU8: heap,
    }
  }
}

/** Drive the client's poll the way hostGdb's 20 ms timer does. */
async function settle(client: RspClient, ticks = 40) {
  for (let i = 0; i < ticks; i++) {
    client.poll()
    await Promise.resolve()
  }
}

async function attached(): Promise<{ stub: FakeStub; client: RspClient }> {
  const stub = new FakeStub()
  const client = new RspClient(chardevRspTransport(stub.exports()))
  const started = client.start()
  await settle(client)
  await started
  return { stub, client }
}

describe('RspClient run control', () => {
  it('never writes a packet to a running machine', async () => {
    const { stub, client } = await attached()
    await client.continue()
    expect(stub.running).toBe(true)

    // A thread walk that outlived the resume. Before the gate, this reached the
    // stub and froze the guest with nothing said about it.
    await expect(client.readMemory(0x4000_0000, 4)).rejects.toThrow(/running/)
    expect(stub.silentStops).toBe(0)
    expect(stub.running).toBe(true)
  })

  it('does not resume twice on a double-click', async () => {
    const { stub, client } = await attached()
    await client.continue()
    await client.continue()
    // The second vCont;c would have been a stray byte: machine stopped, no
    // stop reply, page still showing "running".
    expect(stub.silentStops).toBe(0)
    expect(stub.running).toBe(true)
  })

  it('coalesces overlapping halts into one break', async () => {
    const { stub, client } = await attached()
    await client.continue()

    const first = client.interrupt()
    const second = client.interrupt()
    await settle(client)
    await expect(first).resolves.toMatchObject({ kind: 'signal' })
    await expect(second).resolves.toMatchObject({ kind: 'signal' })
    // One break for two clicks. The second used to cancel the first one's wait
    // and post another 0x03 — which the now-stopped stub threw away, leaving
    // nobody waiting for the single reply that did come back.
    expect(stub.breaks).toBe(1)
    expect(stub.discardedBreaks).toBe(0)
    expect(stub.running).toBe(false)
    expect(stub.silentStops).toBe(0)
  })

  it('answers a halt on an already-stopped machine without a write', async () => {
    const { stub, client } = await attached()
    const before = stub.packets.length

    // The wedge: repeated Pause on a machine that is already halted. The stub
    // discards the 0x03, so waiting for a reply timed out and the caller was
    // told the pause had failed.
    await expect(client.interrupt()).resolves.toMatchObject({ kind: 'signal' })
    expect(stub.packets.length).toBe(before)
    expect(stub.discardedBreaks).toBe(0)
    expect(client.isRunning()).toBe(false)
  })

  it('recovers when the machine stopped behind the page’s back', async () => {
    const { stub, client } = await attached()
    await client.continue()
    expect(client.isRunning()).toBe(true)

    // Something halted the guest without a stop reply (a stray byte from any
    // older build, a lost packet). The page still believes it is running.
    stub.running = false

    // A running stub always answers 0x03, so silence means "already stopped".
    // Adopting that is what keeps Pause/Resume from deadlocking for good.
    await expect(client.interrupt()).resolves.toMatchObject({ kind: 'signal' })
    expect(client.isRunning()).toBe(false)

    // And the machine can be let go again.
    await client.continue()
    expect(stub.running).toBe(true)
  })

  it('fires the stop handler once per stop, not twice', async () => {
    const { client } = await attached()
    let stops = 0
    client.setStopHandler(() => {
      stops++
    })
    await client.continue()

    const halt = client.interrupt()
    await settle(client)
    await halt
    // The awaiting caller runs its own register/thread/stack refresh; the
    // handler firing as well ran the whole walk twice for one pause.
    expect(stops).toBe(0)
  })

  it('reports an asynchronous stop through the handler', async () => {
    const { stub, client } = await attached()
    let stops = 0
    client.setStopHandler(() => {
      stops++
    })
    await client.continue()

    // A breakpoint hit nobody was awaiting.
    stub.feed(0x03)
    await settle(client)
    expect(stops).toBe(1)
    expect(client.isRunning()).toBe(false)
  })
})
