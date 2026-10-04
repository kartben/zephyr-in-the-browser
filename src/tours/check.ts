/**
 * A tour, checked against a built image without booting it.
 *
 * The samples track Zephyr `main`, so the code a tour points at moves under it,
 * and until now the only thing that noticed was a learner. The worst case is
 * silent: a `/pattern/` anchor stops matching upstream, its line-number
 * fallback still resolves, and the card marks the wrong line with complete
 * confidence. Nothing errors, because nothing is wrong as far as the page can
 * tell.
 *
 * Everything here is a lookup the page does anyway when a tour arms, done ahead
 * of time against the same ELF, shipped sources and devicetree. Pure:
 * src/tours/images.test.ts reads the files, runs it for every tour on every
 * board that packages the tour's sample, and prints the table.
 */

import { statementAddresses, type LineIndex } from '@/debug/dwarfLines'
import type { SymbolIndex } from '@/debug/elfSymbols'
import type { GdbArch } from '@/debug/gdb/regs'
import {
  anchorAlternatives,
  enclosingFunction,
  normalizeAddr,
  resolveAnchor,
  sourceSpelling,
  type AnchorContext,
  type ResolvedAnchor,
} from '@/tours/anchors'
import { expressionNames, type ExpressionNames } from '@/tours/expr'
import { resolveHighlightSpecs, type HighlightSpec, type TourDoc, type TourStep } from '@/tours/parse'
import { predicateIdentifiers } from '@/tours/predicate'

export interface CheckContext {
  symbols: SymbolIndex | null
  lines: LineIndex | null
  arch: GdbArch | null
  /**
   * The sample's shipped sources by lowercase basename, split into lines, or
   * null when the image ships none at all: a tarball built before the tour
   * existed, whose pattern anchors fall back to line numbers by design.
   */
  sources: Map<string, string[]> | null
  /** The image's flattened devicetree, for `dts:`, or null when it has none. */
  dts: { name: string; lines: string[] } | null
  /**
   * Offset of a struct member in the image's DWARF, or null when it does not
   * describe one: what a member view (`k_msgq(q).used_msgs`) resolves through.
   * Absent, member views go unchecked.
   */
  member?: (struct: string, member: string) => number | null
  /**
   * Fail, rather than warn, on what this image is missing (sources, a
   * devicetree). A fresh image build ships both, so it can insist.
   */
  strict: boolean
}

export type FindingKind =
  /** No alternative of `at:` resolves. */
  | 'unresolved'
  /** A `/pattern/` stopped matching and a later fallback took over. */
  | 'drift'
  /** The line-number fallback no longer lands where its pattern does. */
  | 'stale-line'
  /** The landed line starts statements at several addresses. */
  | 'multi-address'
  /** Several functions share the anchor's name. */
  | 'ambiguous'
  /** A `highlight:` entry marks nothing. */
  | 'highlight'
  /** None of a step's `dts:` entries matches this board's devicetree. */
  | 'dts'
  /** An expression names a symbol the ELF does not have. */
  | 'symbol'
  /** A member view names a struct member the image's DWARF does not describe. */
  | 'member'
  /** An expression does not even tokenize. */
  | 'expression'
  /** The image lacks what a check needs. */
  | 'unchecked'
  /** There is no image to check against. */
  | 'no-image'

export interface Finding {
  /** 1-based step number, or null for the image as a whole. */
  step: number | null
  severity: 'fail' | 'warn'
  kind: FindingKind
  message: string
}

/** What one step's checks report into. */
interface StepCheck {
  add(severity: Finding['severity'], kind: FindingKind, message: string): void
  /** Set when a check needed the shipped sources and the image has none. */
  noSources: boolean
  /** Set when a `dts:` entry needed the devicetree and the image has none. */
  noDts: boolean
}

/** Every finding for one tour against one image, image-wide ones first. */
export function checkTour(doc: TourDoc, ctx: CheckContext): Finding[] {
  const findings: Finding[] = []
  let noSources = 0
  let noDts = 0

  for (const step of doc.steps) {
    const check: StepCheck = {
      add: (severity, kind, message) =>
        findings.push({ step: step.index + 1, severity, kind, message }),
      noSources: false,
      noDts: false,
    }
    const anchor = checkAnchor(step.at, ctx, check)
    if (anchor) checkHighlights(step, anchor, ctx, check)
    checkDts(step, ctx, check)
    checkExpressions(step, ctx, check)
    if (check.noSources) noSources++
    if (check.noDts) noDts++
  }

  const severity = ctx.strict ? 'fail' : 'warn'
  const imageWide: Finding[] = []
  if (noSources > 0) {
    imageWide.push({
      step: null,
      severity,
      kind: 'unchecked',
      message:
        `the image ships no sources for this sample, so ${count(noSources, 'step')} ` +
        'with a pattern anchor or a highlight went unchecked: rebuild the images',
    })
  }
  if (noDts > 0) {
    imageWide.push({
      step: null,
      severity,
      kind: 'unchecked',
      message: `the image ships no devicetree, so ${count(noDts, 'step')} with \`dts:\` went unchecked`,
    })
  }
  return [...imageWide, ...findings]
}

/**
 * Resolve `at:` one alternative at a time, the way the page does, but keep the
 * reasons the earlier ones failed: a pattern that no longer matches is exactly
 * what the page papers over by falling back.
 */
function checkAnchor(at: string, ctx: CheckContext, check: StepCheck): ResolvedAnchor | null {
  const anchorCtx: AnchorContext = {
    symbols: ctx.symbols,
    lines: ctx.lines,
    arch: ctx.arch,
    sources: ctx.sources ?? undefined,
  }
  const alternatives = anchorAlternatives(at)
  const failed: Array<{ alternative: string; error: string }> = []
  let won: { index: number; anchor: ResolvedAnchor } | null = null
  for (const [index, alternative] of alternatives.entries()) {
    const result = resolveAnchor(alternative, anchorCtx)
    if (result.ok) {
      won = { index, anchor: result.anchor }
      break
    }
    failed.push({ alternative, error: result.error })
  }

  if (!won) {
    const why = failed.length > 0 ? failed.map((f) => f.error).join('; ') : '`at:` is empty'
    check.add('fail', 'unresolved', `\`${at}\` resolves nowhere: ${why}`)
    return null
  }
  const { anchor } = won
  const used = alternatives[won.index]!

  // Only a pattern counts as drift. A function that is missing is more often
  // a per-board alternative (`gpio_virtio_pin_configure | qhg_pin_configure`)
  // than a mistake, and the fallback is then the point.
  for (const { alternative, error } of failed) {
    if (sourceSpelling(alternative)?.kind !== 'pattern' || ctx.lines === null) continue
    if (ctx.sources === null) {
      check.noSources = true
      continue
    }
    check.add(
      'fail',
      'drift',
      `${error}, so the page falls back to \`${used}\` and stops on ${where(anchor)}, ` +
        'which may no longer be the right line: fix the pattern',
    )
    break
  }

  const spelled = sourceSpelling(used)
  if (spelled && ctx.lines && anchor.line !== null) {
    checkStatements(spelled.file, anchor, ctx.lines, anchorCtx, check)
  }
  if (spelled?.kind === 'pattern') {
    checkLineFallbacks(alternatives.slice(won.index + 1), spelled.file, used, anchor, anchorCtx, check)
  }
  const name = anchor.via === 'symbol' ? anchor.symbol : null
  if (name !== null && ctx.symbols) {
    const named = ctx.symbols.byName.filter((s) => s.name === name)
    if (named.length > 1) {
      check.add(
        'warn',
        'ambiguous',
        `${named.length} functions are named \`${name}\`, and the step stops in the one at ` +
          hex(normalizeAddr(named[0]!.addr, ctx.arch)),
      )
    }
  }
  return anchor
}

/**
 * One breakpoint covers one address. A line whose statements start in several
 * places (inlined into more than one caller, a loop header, a `LOG_*()`
 * expansion of ten code ranges) only stops in the first of them.
 */
function checkStatements(
  file: string,
  anchor: ResolvedAnchor,
  lines: LineIndex,
  anchorCtx: AnchorContext,
  check: StepCheck,
): void {
  const addrs = statementAddresses(lines, file, anchor.line!)
  if (addrs.length < 2) return
  const functions = [...new Set(addrs.map((addr) => enclosingFunction(addr, anchorCtx) ?? hex(addr)))]
  const line = `${baseName(anchor.file ?? file)}:${anchor.line}`
  check.add(
    'warn',
    'multi-address',
    functions.length > 1
      ? `${line} has code in ${functions.length} functions (${functions.join(', ')}), and the step ` +
          `only stops in ${anchor.symbol ?? functions[0]}: inlined code does this`
      : `${line} starts statements at ${addrs.length} addresses in ${functions[0]}, and the step only ` +
          'stops at the first: a `LOG_*()` line, a loop header or code inlined twice does this',
  )
}

/**
 * The line number after a pattern is what runs on an image without sources,
 * which is the one place nobody looks. Keep it landing where the pattern does.
 */
function checkLineFallbacks(
  later: string[],
  file: string,
  used: string,
  anchor: ResolvedAnchor,
  anchorCtx: AnchorContext,
  check: StepCheck,
): void {
  for (const alternative of later) {
    const spelled = sourceSpelling(alternative)
    if (spelled?.kind !== 'line' || baseName(spelled.file) !== baseName(file)) continue
    const result = resolveAnchor(alternative, anchorCtx)
    if (result.ok && result.anchor.addr === anchor.addr) continue
    const lands = result.ok ? `stops on ${where(result.anchor)}` : 'resolves nowhere'
    check.add(
      'warn',
      'stale-line',
      `the fallback \`${alternative}\` ${lands}, but \`${used}\` stops on ${where(anchor)}: ` +
        'update the line number',
    )
  }
}

/** `highlight:` is resolved against the file the step stopped in, as the card does. */
function checkHighlights(step: TourStep, anchor: ResolvedAnchor, ctx: CheckContext, check: StepCheck): void {
  if (step.highlight.length === 0) return
  if (anchor.file === null) {
    check.add('fail', 'highlight', 'the step stops on no known source line, so `highlight:` has nothing to mark')
    return
  }
  if (ctx.sources === null) {
    check.noSources = true
    return
  }
  const name = baseName(anchor.file)
  const text = ctx.sources.get(name.toLowerCase())
  if (!text) {
    check.add(
      'fail',
      'highlight',
      `the step stops in ${name}, which the image does not ship, so \`highlight:\` cannot show`,
    )
    return
  }
  for (const spec of step.highlight) checkHighlight(spec, name, text, check)
}

/**
 * `dts:` is matched against each board's own devicetree, and those differ
 * (`button0: button_0` on one board is `user_button1: button_1` on another),
 * so a step may list one entry per spelling and expect only some to match.
 * What is worth saying is a board where none does: the card shows that board
 * no devicetree at all. Only a warning, since the prose still stands.
 */
function checkDts(step: TourStep, ctx: CheckContext, check: StepCheck): void {
  if (step.dts.length === 0) return
  if (ctx.dts === null) {
    check.noDts = true
    return
  }
  const { name, lines } = ctx.dts
  if (step.dts.some((spec) => marks(spec, lines))) return
  const written = step.dts.map((spec) => `\`${spellSpec(spec)}\``).join(', ')
  check.add(
    'warn',
    'dts',
    `no \`dts:\` entry (${written}) matches ${name}, so the card shows no devicetree on this board`,
  )
}

/** A highlight that marks nothing is dropped on the card without a word. */
function checkHighlight(spec: HighlightSpec, name: string, text: string[], check: StepCheck): void {
  if (marks(spec, text)) return
  check.add(
    'fail',
    'highlight',
    spec.kind === 'lines'
      ? `\`highlight: ${spellSpec(spec)}\` starts past the end of ${name} (${lineCount(text)} lines)`
      : `\`highlight: ${spellSpec(spec)}\` matches nothing in ${name}`,
  )
}

/** Whether a spec lights up anything at all in `text`. */
function marks(spec: HighlightSpec, text: string[]): boolean {
  if (spec.kind === 'lines') return spec.start <= lineCount(text)
  return resolveHighlightSpecs([spec], text).length > 0
}

/** Lines in a file split on `\n`, not counting the empty one after a final newline. */
function lineCount(text: string[]): number {
  return text.at(-1) === '' ? text.length - 1 : text.length
}

/**
 * Every symbol an expression names has to be in the ELF, or the card shows
 * "no symbol" where the value should be, and a `check:` on one can never pass.
 * Registers are not symbols, so `$arg0` passes whatever the guest. A member
 * view's member has to be in the DWARF just the same.
 */
function checkExpressions(step: TourStep, ctx: CheckContext, check: StepCheck): void {
  const written: Array<[label: string, expr: string]> = []
  for (const watch of step.watch) {
    written.push([`watch: ${watch.label === null ? '' : `${watch.label} = `}${watch.expr}`, watch.expr])
  }
  if (step.memory) {
    written.push([`memory: at: ${step.memory.at}`, step.memory.at])
    const mark = step.memory.mark
    if (mark) {
      const label = `memory: mark: ${mark.start}..${mark.end}`
      written.push([label, mark.start], [label, mark.end])
    }
  }
  if (step.objects?.focus) written.push([`objects: focus: ${step.objects.focus}`, step.objects.focus])

  const named: Array<[label: string, names: ExpressionNames]> = []
  for (const [label, expr] of written) {
    const names = expressionNames(expr)
    if (names === null) check.add('fail', 'expression', `\`${label}\` is not an expression`)
    else named.push([label, names])
  }
  // The parser has already refused a predicate that is not an expression.
  for (const predicate of step.check) named.push([`check: ${predicate.text}`, predicateIdentifiers(predicate)])

  for (const [label, names] of named) {
    for (const name of names.symbols) {
      if (!hasSymbol(ctx.symbols, name)) {
        check.add('fail', 'symbol', `\`${label}\`: no symbol \`${name}\` in this build`)
      }
    }
    if (!ctx.member) continue
    for (const { struct, member } of names.members) {
      if (ctx.member(struct, member) === null) {
        check.add('fail', 'member', `\`${label}\`: \`struct ${struct}\` has no member \`${member}\` in this build`)
      }
    }
  }
}

/** Whatever the live target would find: a data symbol, or else a function. */
function hasSymbol(symbols: SymbolIndex | null, name: string): boolean {
  return symbols !== null && (symbols.objects.has(name) || symbols.byName.some((s) => s.name === name))
}

function spellSpec(spec: HighlightSpec): string {
  if (spec.kind === 'lines') return spec.start === spec.end ? `${spec.start}` : `${spec.start}-${spec.end}`
  return spec.extra > 0 ? `/${spec.pattern}/ + ${spec.extra}` : `/${spec.pattern}/`
}

/** `main.c:38 in main`, as much of it as is known. */
function where(anchor: ResolvedAnchor): string {
  const at = anchor.file !== null && anchor.line !== null ? `${baseName(anchor.file)}:${anchor.line}` : hex(anchor.addr)
  return anchor.symbol !== null ? `${at} in ${anchor.symbol}` : at
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function hex(addr: number): string {
  return `0x${addr.toString(16)}`
}

/** `1 step`, `3 steps`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

export interface ReportRow {
  tour: string
  board: string
  /** The ELF checked, `blinky.elf` or its traced twin `blinky_trace.elf`. */
  image: string
  /** Step number, or null for the image as a whole. */
  step: number | null
  /** `ok`, or a finding's severity and kind: `FAIL drift`, `warn multi-address`. */
  status: string
  detail: string
}

/** One row per finding, or a single `ok` row for an image with none. */
export function reportRows(
  image: Pick<ReportRow, 'tour' | 'board' | 'image'>,
  findings: Finding[],
  steps: number,
): ReportRow[] {
  if (findings.length === 0) return [{ ...image, step: null, status: 'ok', detail: count(steps, 'step') }]
  return findings.map((finding) => ({
    ...image,
    step: finding.step,
    status: `${finding.severity === 'fail' ? 'FAIL' : 'warn'} ${finding.kind}`,
    detail: finding.message,
  }))
}

/** The rows as an aligned plain-text table, for a terminal or a CI log. */
export function formatReport(rows: ReportRow[]): string {
  const header = ['tour', 'board', 'image', 'step', 'status', 'detail']
  const cells = rows.map((row) => [
    row.tour,
    row.board,
    row.image,
    row.step === null ? '-' : String(row.step),
    row.status,
    row.detail,
  ])
  const widths = header.map((title, i) => Math.max(title.length, ...cells.map((cell) => cell[i]!.length)))
  return [header, ...cells]
    .map((cell) =>
      cell
        .map((text, i) => (i === cell.length - 1 ? text : text.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}
