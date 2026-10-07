import { describe, expect, it } from 'vitest'
import { traceTabFromTourName, visibleTraceTabs, type TraceTab } from './traceTabs'

const NONE = { zbus: false, net: false, power: false }

describe('visibleTraceTabs', () => {
  it('keeps Timeline and IPC on a trace with nothing else', () => {
    expect(visibleTraceTabs(NONE)).toEqual(['schedule', 'queues'])
  })

  it('shows each optional tab once its trace has something for it', () => {
    expect(visibleTraceTabs({ ...NONE, net: true })).toEqual(['schedule', 'queues', 'net'])
    expect(visibleTraceTabs({ ...NONE, power: true })).toEqual(['schedule', 'queues', 'power'])
    expect(visibleTraceTabs({ zbus: true, net: true, power: true })).toEqual([
      'schedule',
      'queues',
      'zbus',
      'net',
      'power',
    ])
  })

  it('shows an empty tab a tour card points at, so its look still lands', () => {
    // What a step's `look: trace.power` resolves to, on a guest without PM.
    const target = traceTabFromTourName('power')
    const pinned = (tab: TraceTab) => tab === target
    expect(visibleTraceTabs(NONE, pinned)).toEqual(['schedule', 'queues', 'power'])
  })
})
