/**
 * Diagrams in tour prose: a fenced ```mermaid block, drawn on the card by
 * tour/TourDiagram.tsx.
 *
 * A step about one part of an application wants the rest of it in view but
 * quiet, so a tour marks nodes with one of two classes the page styles in
 * both colour schemes: `focus`, what the step is about, and `dim`, everything
 * else. Authors never write a `classDef` or count edges for a `linkStyle`: the
 * page adds both, and an edge that touches a dim node is dimmed with it.
 *
 * Everything here is plain text in and out, so it is tested without Mermaid
 * or a DOM.
 */

/** The classes a tour diagram can use without defining them. */
export const DIAGRAM_CLASSES = ['focus', 'dim'] as const

/** Concrete colours, resolved from the page's tokens when a diagram is drawn. */
export interface DiagramColors {
  focusFill: string
  focusStroke: string
  focusText: string
  dimFill: string
  dimStroke: string
  dimText: string
  /** Edges, and the arrowheads Mermaid colours to match. */
  line: string
  dimLine: string
}

/** One edge as Mermaid's flowchart parser reports it, in source order. */
export interface DiagramEdge {
  start: string
  end: string
}

/**
 * The first statement of a Mermaid diagram, past blank lines, `%%` comments
 * and directives, and a `---` front matter block.
 */
function firstStatement(source: string): string {
  const lines = source.split('\n')
  let i = 0
  if (lines[0]?.trim() === '---') {
    i = lines.findIndex((line, n) => n > 0 && line.trim() === '---') + 1
    if (i === 0) return ''
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line !== '' && !line.startsWith('%%')) return line
  }
  return ''
}

/** True for a flowchart, the one diagram type `focus` and `dim` style. */
export function isFlowchart(source: string): boolean {
  return /^(flowchart|graph)\b/.test(firstStatement(source))
}

/** The edges, by index, that touch a node in `dim`. */
export function dimmedEdges(edges: readonly DiagramEdge[], dim: ReadonlySet<string>): number[] {
  const out: number[] = []
  edges.forEach((edge, i) => {
    if (dim.has(edge.start) || dim.has(edge.end)) out.push(i)
  })
  return out
}

/**
 * The source Mermaid draws: the author's flowchart, then the styles for
 * `focus` and `dim` and the dimmed edges. Other diagram types come back as
 * written, since `classDef` and `linkStyle` are flowchart syntax.
 */
export function styledDiagramSource(
  source: string,
  colors: DiagramColors,
  dimEdgeIndexes: readonly number[],
): string {
  if (!isFlowchart(source)) return source
  const lines = [
    source.trimEnd(),
    `classDef focus fill:${colors.focusFill},stroke:${colors.focusStroke},color:${colors.focusText},stroke-width:1.5px`,
    `classDef dim fill:${colors.dimFill},stroke:${colors.dimStroke},color:${colors.dimText}`,
  ]
  if (dimEdgeIndexes.length > 0) {
    lines.push(`linkStyle ${dimEdgeIndexes.join(',')} stroke:${colors.dimLine}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Class names a diagram uses that neither the page nor the diagram defines:
 * `class a,b name` and the `a:::name` shorthand, against `focus`, `dim` and the
 * diagram's own `classDef`s. Such a class does nothing, so a test reports it.
 */
export function unknownDiagramClasses(source: string): string[] {
  const defined = new Set<string>(DIAGRAM_CLASSES)
  for (const m of source.matchAll(/^\s*classDef\s+([\w,-]+)/gm)) {
    for (const name of m[1]!.split(',')) defined.add(name)
  }
  const used = new Set<string>()
  for (const m of source.matchAll(/^\s*class\s+\S+\s+([\w-]+)\s*;?\s*$/gm)) used.add(m[1]!)
  for (const m of source.matchAll(/:::([\w-]+)/g)) used.add(m[1]!)
  return [...used].filter((name) => !defined.has(name))
}
