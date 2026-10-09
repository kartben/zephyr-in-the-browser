// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The topology graph lays itself out with elk; this test is about the depth chart.
vi.mock('@/components/QueueGraph', () => ({ QueueGraph: () => null }))

import { QueuesView } from './QueuesView'
import { fallbackDefs, reconstructQueues, TraceReader } from '@/ctf'
import { queueBacklog } from '@/testing/ctfSynth'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('QueuesView', () => {
  /*
   * A replay's IPC tab draws a second depth chart beside the live panel's. With
   * one fixed clip-path id, `url(#…)` found the first chart's clip, and the
   * replay's rows were cut off at the live chart's narrower width.
   */
  it('clips each chart on the page to its own plot', () => {
    const reader = new TraceReader(fallbackDefs())
    reader.feed(queueBacklog(20))
    const tr = reader.tr
    const queues = reconstructQueues(tr)
    const refs = [createRef<SVGSVGElement>(), createRef<SVGSVGElement>()]
    act(() =>
      root.render(
        <>
          {refs.map((ref, i) => (
            <QueuesView
              key={i}
              tr={tr}
              queues={queues}
              flowEvents={[]}
              view0={tr.t0}
              view1={tr.t1}
              follow
              eventCount={1}
              svgRef={ref}
            />
          ))}
        </>,
      ),
    )

    const clips = refs.map((ref) => {
      const svg = ref.current!
      const id = svg.querySelector('clipPath')!.getAttribute('id')!
      expect(svg.querySelector('g.y-zoom')!.getAttribute('clip-path')).toBe(`url(#${id})`)
      return id
    })
    expect(new Set(clips).size).toBe(2)
    expect(document.querySelectorAll(`[id="${clips[0]}"]`)).toHaveLength(1)
  })
})
