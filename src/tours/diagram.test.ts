import { describe, expect, it } from 'vitest'
import {
  dimmedEdges,
  isFlowchart,
  styledDiagramSource,
  unknownDiagramClasses,
  type DiagramColors,
} from '@/tours/diagram'

const COLORS: DiagramColors = {
  focusFill: '#f5f3ff',
  focusStroke: '#7c3aed',
  focusText: '#1e1b4b',
  dimFill: '#f8fafc',
  dimStroke: '#d6dbe3',
  dimText: '#9aa3b2',
  line: '#7c3aed',
  dimLine: '#d6dbe3',
}

describe('isFlowchart', () => {
  it('reads the first statement, past comments and front matter', () => {
    expect(isFlowchart('flowchart LR\n  a --> b')).toBe(true)
    expect(isFlowchart('graph TD\n  a --> b')).toBe(true)
    expect(isFlowchart('\n%% the pipeline\n%%{init: {}}%%\nflowchart LR\n  a --> b')).toBe(true)
    expect(isFlowchart('---\ntitle: Pipeline\n---\nflowchart LR\n  a --> b')).toBe(true)
    expect(isFlowchart('sequenceDiagram\n  a->>b: hi')).toBe(false)
    expect(isFlowchart('flowcharts LR')).toBe(false)
    expect(isFlowchart('---\nnever closed')).toBe(false)
  })
})

describe('dimmedEdges', () => {
  it('dims every edge that touches a dim node', () => {
    const edges = [
      { start: 'temp', end: 'q' },
      { start: 'q', end: 'agg' },
      { start: 'agg', end: 'cv' },
      { start: 'cv', end: 'c0' },
    ]
    expect(dimmedEdges(edges, new Set(['cv', 'c0']))).toEqual([2, 3])
    expect(dimmedEdges(edges, new Set(['temp']))).toEqual([0])
    expect(dimmedEdges(edges, new Set())).toEqual([])
  })
})

describe('styledDiagramSource', () => {
  const source = 'flowchart LR\n  a --> b\n  b --> c\n  class a focus\n  class c dim\n'

  it('adds the two classes and the dimmed edges after the flowchart', () => {
    expect(styledDiagramSource(source, COLORS, [1])).toBe(
      'flowchart LR\n  a --> b\n  b --> c\n  class a focus\n  class c dim\n' +
        'classDef focus fill:#f5f3ff,stroke:#7c3aed,color:#1e1b4b,stroke-width:1.5px\n' +
        'classDef dim fill:#f8fafc,stroke:#d6dbe3,color:#9aa3b2\n' +
        'linkStyle 1 stroke:#d6dbe3\n',
    )
  })

  it('writes no linkStyle when no edge is dimmed', () => {
    expect(styledDiagramSource(source, COLORS, [])).not.toContain('linkStyle')
  })

  it('leaves a diagram that is not a flowchart as written', () => {
    const seq = 'sequenceDiagram\n  a->>b: hi\n'
    expect(styledDiagramSource(seq, COLORS, [0])).toBe(seq)
  })
})

describe('unknownDiagramClasses', () => {
  it('accepts focus, dim and the diagram’s own classDefs', () => {
    const source = [
      'flowchart LR',
      '  a --> b:::warm',
      '  class a focus',
      '  class b,c dim',
      '  classDef warm fill:#fed7aa',
    ].join('\n')
    expect(unknownDiagramClasses(source)).toEqual([])
  })

  it('reports a class nothing defines, written either way', () => {
    const source = 'flowchart LR\n  a --> b:::hot\n  class a highlight\n'
    expect(unknownDiagramClasses(source).sort()).toEqual(['highlight', 'hot'])
  })
})
