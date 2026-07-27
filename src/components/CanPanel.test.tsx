import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The panel's Add / Send controls call into hostCan, which drives the INT pin
// through hostGpio's requestAnimationFrame path. Rendering never fires them;
// the stub only keeps the import graph out of the DOM.
vi.mock('@/hostGpio', () => ({ setInput: vi.fn() }))

import { CanView } from './CanPanel'
import { createCanBus, type CanLogEntry, type CanNodeSnapshot } from '@/can/bus'
import { nodeType } from '@/can/nodes'

/**
 * What a reader actually gets off this panel: who is on the bus, what state
 * they are in, and the three trace rows that carry the class's whole point — a
 * delivered frame, one the filters dropped, and one nobody acknowledged.
 *
 * Driven through a real bus rather than hand-built fixtures, so the strings
 * asserted here are the ones the model genuinely produces.
 */
function html(nodes: readonly CanNodeSnapshot[], log: readonly CanLogEntry[] = []): string {
  return renderToStaticMarkup(<CanView nodes={nodes} log={log} />)
}

function text(nodes: readonly CanNodeSnapshot[], log: readonly CanLogEntry[] = []): string {
  return html(nodes, log).replace(/<[^>]+>/g, ' ')
}

/**
 * A bus with the controller plus whatever presets the case needs, over a clock
 * the test drives by hand. Time has to be explicit: the medium is only busy
 * for a fraction of a millisecond, so a clock that free-runs never produces
 * the contention the arbitration row depends on.
 */
function harness(...presets: string[]) {
  let t = 0
  const bus = createCanBus(() => t)
  bus.attach({ id: 'can0', name: 'can0', local: true })
  const ids = presets.map((preset, i) => {
    const id = `${preset}-${i}`
    bus.attach(nodeType(preset)!.create(id, { id: 0x0a0, periodMs: 100 }))
    return id
  })
  return {
    bus,
    ids,
    advance(ms: number) {
      t += ms
      bus.pump(t)
    },
  }
}

const frame = (id: number, data: number[]) => ({
  id,
  ext: false,
  rtr: false,
  data: Uint8Array.from(data),
})

describe('CanView', () => {
  it('says so plainly when nothing is attached', () => {
    const out = text([])
    expect(out).toContain('Nothing attached.')
    expect(out).toContain('Nothing has crossed the bus yet.')
  })

  it('lists the controller and offers loopback instead of unplug', () => {
    const out = html(harness().bus.nodes())
    expect(out).toContain('can0')
    expect(out).toContain('error-active')
    expect(out).toContain("This board&#x27;s controller")
    // Every other node gets an unplug button; the local one gets loopback.
    expect(out).not.toContain('Unplug can0')
    expect(out).toContain('Wire loopback on can0')
    expect(out).not.toContain('Disable loopback on can0')
  })

  it('marks the loopback control pressed when enabled', () => {
    const { bus } = harness()
    bus.setLoopback('can0', true)
    const out = html(bus.nodes())
    expect(out).toContain('Disable loopback on can0')
    expect(out).toContain('aria-pressed="true"')
    expect(text(bus.nodes())).toContain('loopback')
  })

  it('shows a peer with its behaviour summary and an unplug button', () => {
    const out = html(harness('babbling').bus.nodes())
    expect(out).toContain('Babbling')
    expect(out).toContain('0x0A0 every 100 ms')
    expect(out).toContain('TEC 0 REC 0')
    expect(out).toContain('Unplug Babbling')
  })

  it('distinguishes Listener from Silent in the roster', () => {
    const out = text(harness('listener', 'silent').bus.nodes())
    expect(out).toContain('acks only')
    expect(out).toContain('listen-only')
  })

  it('offers only the fields the selected node type needs', () => {
    const out = html([])
    // Babbling leads the catalog, so both of its fields are shown.
    expect(out).toContain('Node ID')
    expect(out).toContain('Period in ms')
    expect(out).toContain('Counter, Listener and Silent take none.')
  })

  it('renders a delivered frame and marks a dropped one', () => {
    let t = 0
    const bus = createCanBus(() => t)
    bus.attach({
      id: 'can0',
      name: 'can0',
      local: true,
      receive: (f) => (f.id === 0x100 ? 'accepted' : 'filtered'),
    })
    bus.attach(nodeType('listener')!.create('l', { id: 0, periodMs: 0 }))

    bus.send('l', frame(0x100, [1, 2]))
    bus.send('l', frame(0x2ff, [3]))
    for (let i = 0; i < 5; i++) {
      t += 5
      bus.pump(t)
    }

    const out = text(bus.nodes(), bus.log())
    expect(out).toContain('0x100')
    expect(out).toContain('01 02')
    expect(out).toContain('0x2FF')
    expect(out).toContain('filtered')
  })

  it('reports an unacknowledged frame with the counter that follows', () => {
    const { bus, advance } = harness()
    bus.send('can0', frame(0x100, [9]))
    advance(5)

    const out = text(bus.nodes(), bus.log())
    expect(out).toContain('no ACK')
    expect(out).toContain('TEC 8')
  })

  it('shows a lost arbitration as its own row', () => {
    const { bus, ids, advance } = harness('listener')
    // The first goes out on an idle bus and occupies the medium; the next two
    // arrive while it is busy, so they contend when it frees.
    bus.send(ids[0]!, frame(0x000, [0]))
    bus.send(ids[0]!, frame(0x200, [2]))
    bus.send('can0', frame(0x100, [1]))
    advance(10)

    const out = text(bus.nodes(), bus.log())
    expect(out).toContain('lost arbitration to')
    expect(out).toContain('retry')
    // Lane strip mounts once there is traffic to place.
    expect(out).toContain('Arbitration')
    expect(html(bus.nodes(), bus.log())).toContain('aria-label="Arbitration lanes"')
    expect(html(bus.nodes(), bus.log())).toContain('Following live edge')
    expect(html(bus.nodes(), bus.log())).toContain('Zoom in')
    expect(html(bus.nodes(), bus.log())).toContain('Zoom out')
  })

  it('keeps the lane strip off an idle bus', () => {
    const out = text(harness('babbling').bus.nodes())
    expect(out).not.toContain('Arbitration')
  })

  it('surfaces Recover only once the controller is bus-off', () => {
    const { bus, advance } = harness()
    expect(text(bus.nodes(), bus.log())).not.toContain('Recover')

    bus.send('can0', frame(0x100, [1]))
    for (let i = 0; i < 40; i++) advance(5)

    const out = text(bus.nodes(), bus.log())
    expect(out).toContain('bus-off')
    expect(out).toContain('Recover')
  })
})
