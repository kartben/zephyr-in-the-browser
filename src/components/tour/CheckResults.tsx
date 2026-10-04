/**
 * The verdict on a step's `check:` rows, under its values.
 *
 * Passed is a banner and the step's `pass:` line: the reader did what the step
 * asked, and the numbers that prove it would only be noise. Not yet lists the
 * rows that did not hold, each with what the guest actually had, since that is
 * what the reader acts on, then the step's `fail:` line. A row that could not
 * be read makes neither claim: the banner says Not checked, and why.
 */

import { CircleAlert, CircleCheck, CircleDashed } from 'lucide-react'
import { InlineMarkdown } from '@/components/Markdown'
import { cn } from '@/lib/utils'
import type { TourCheck, TourCheckRow } from '@/tours/store'

interface Props {
  check: TourCheck
  /** The step's `pass:` line. */
  pass: string | null
  /** The step's `fail:` line. */
  fail: string | null
  /** A real guest was read. False on the mock backend's replay. */
  live: boolean
}

/*
 * `data-tour-check` on the banner carries the verdict for scripts: `pass`,
 * `fail`, or `unread` when nothing could be read (the mock backend's replay,
 * a symbol this build lacks). The headless tour playthrough keys off it to
 * fail a run on a check that should have passed.
 */
const TONES = {
  passed: {
    attr: 'pass',
    Icon: CircleCheck,
    title: 'Passed',
    box: 'border-emerald-500/40 bg-emerald-500/5',
    head: 'text-emerald-700 dark:text-emerald-400',
  },
  failed: {
    attr: 'fail',
    Icon: CircleAlert,
    title: 'Not yet',
    box: 'border-amber-500/40 bg-amber-500/5',
    head: 'text-amber-700 dark:text-amber-400',
  },
  unknown: {
    attr: 'unread',
    Icon: CircleDashed,
    title: 'Not checked',
    box: 'border-border bg-muted/30',
    head: 'text-muted-foreground',
  },
} as const

function Row({ row }: { row: TourCheckRow }) {
  const actual = row.values
    .map((side) => (side.ok ? `${side.expr} is ${side.text}` : `${side.expr}: ${side.text}`))
    .join(', ')
  return (
    <li className="min-w-0">
      <code className="block truncate font-mono text-[11px] text-foreground" title={row.text}>
        {row.text}
      </code>
      {actual && (
        <span
          className="block truncate font-mono text-[10.5px] text-muted-foreground"
          title={actual}
        >
          {actual}
        </span>
      )}
    </li>
  )
}

export function CheckResults({ check, pass, fail, live }: Props) {
  const { attr, Icon, title, box, head } = TONES[check.outcome]
  const passed = check.outcome === 'passed'
  const rows = passed ? [] : check.rows.filter((row) => row.pass !== true)
  // Each line is only true of its own verdict. When nothing could be read,
  // neither is, and saying either would be a guess.
  const line = passed ? pass : check.outcome === 'failed' ? fail : null
  return (
    <div data-tour-check={attr} className={cn('space-y-1.5 rounded border px-2 py-1.5', box)}>
      <p className={cn('flex items-center gap-1.5 text-[11.5px] font-medium', head)}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {title}
      </p>
      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((row, i) => (
            <Row key={`${i}:${row.text}`} row={row} />
          ))}
        </ul>
      )}
      {line && (
        <p className="text-[12.5px] leading-relaxed text-foreground">
          <InlineMarkdown text={line} />
        </p>
      )}
      {!live && (
        <p className="text-[10.5px] text-muted-foreground/80">
          Checks read the running guest. Start a sample to see the result.
        </p>
      )}
    </div>
  )
}
