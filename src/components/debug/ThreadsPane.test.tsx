import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DebugSnapshot } from '@/debug/control'
import type { ZephyrThread } from '@/debug/kernel/threads'

// The pane only reads the snapshot it is handed; the live debugger stays out.
vi.mock('@/debug/control', () => ({}))

const { ThreadsPane } = await import('@/components/debug/ThreadsPane')

function thread(name: string, prio: number, addr: number): ZephyrThread {
  return {
    addr,
    name,
    entry: null,
    prio,
    state: 0,
    current: false,
    sp: null,
    stackStart: null,
    stackSize: null,
    pendedOn: null,
    waitingOn: null,
    objectCore: true,
    origPrio: null,
  }
}

const snap = {
  threadInfo: true,
  threads: [
    thread('sysworkq', -1, 0x100),
    thread('aggregator', 3, 0x200),
    thread('consumer0', 6, 0x300),
    thread('consumer1', 6, 0x400),
    thread('sensor_temp', 8, 0x500),
  ],
  threadsLoading: false,
  threadsError: null,
  objects: null,
} as unknown as DebugSnapshot

const names = (html: string) => [...html.matchAll(/data-thread-name="([^"]+)"/g)].map((m) => m[1])

describe('ThreadsPane', () => {
  it('lists every thread by default', () => {
    const html = renderToStaticMarkup(<ThreadsPane snap={snap} onPeek={() => {}} />)
    expect(names(html)).toHaveLength(5)
    expect(html).toContain('5 threads')
  })

  it('lists only the threads a step names, and says how many of how many', () => {
    const html = renderToStaticMarkup(
      <ThreadsPane snap={snap} only={['aggregator', 'consumer*']} onPeek={() => {}} />,
    )
    expect(names(html)).toEqual(['aggregator', 'consumer0', 'consumer1'])
    expect(html).toContain('3 of 5 threads')
    expect(html).not.toContain('No thread here')
  })

  it("dims the last stop's rows while this stop's walk runs, and claims no running thread", () => {
    const running = { ...thread('aggregator', 3, 0x200), current: true }
    const html = renderToStaticMarkup(
      <ThreadsPane snap={{ ...snap, threads: [running], threadsLoading: true }} onPeek={() => {}} />,
    )
    expect(html).toContain('Reading the kernel…')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('opacity-50')
    expect(html).not.toContain('bg-primary/10')
  })

  it('shows the running thread once the walk has landed', () => {
    const running = { ...thread('aggregator', 3, 0x200), current: true }
    const html = renderToStaticMarkup(
      <ThreadsPane snap={{ ...snap, threads: [running] }} onPeek={() => {}} />,
    )
    expect(html).toContain('Live from the kernel')
    expect(html).not.toContain('aria-busy')
    expect(html).toContain('bg-primary/10')
  })

  it('gives a tour card one line per thread: name, priority, state, no addresses', () => {
    const waiting = { ...thread('aggregator', 3, 0x200), state: 2 }
    const html = renderToStaticMarkup(
      <ThreadsPane snap={{ ...snap, threads: [waiting] }} compact onPeek={() => {}} />,
    )
    expect(names(html)).toEqual(['aggregator'])
    expect(html).toContain('prio 3')
    expect(html).not.toContain('tcb ')
    expect(html).not.toContain('cycles')
    expect(html).not.toContain('max-h-')
  })

  it('says which names matched no thread', () => {
    const html = renderToStaticMarkup(
      <ThreadsPane snap={snap} only={['aggregator', 'storage']} onPeek={() => {}} />,
    )
    expect(names(html)).toEqual(['aggregator'])
    expect(html).toContain('No thread here is named “storage”.')
  })
})
