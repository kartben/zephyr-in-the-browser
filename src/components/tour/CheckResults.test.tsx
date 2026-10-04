import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CheckResults } from './CheckResults'
import type { TourCheck, TourCheckRow } from '@/tours/store'

/**
 * The banner is the whole point of a check, so pin what each verdict says:
 * which line of the step's copy appears, and which rows, with which values.
 */

const PASS = 'The alarm got through. Dropping the oldest reading made room.'
const FAIL = 'Another alarm was lost. Try a **different policy**, then press SW0 again.'

const lost = (value: string, pass: boolean | null, ok = true): TourCheckRow => ({
  text: 'alarms_lost as u32 == 1',
  pass,
  values: [{ expr: 'alarms_lost', text: value, ok }],
})
const inIsr: TourCheckRow = {
  text: 'alarm_in_isr as u32 == 1',
  pass: true,
  values: [{ expr: 'alarm_in_isr', text: '1', ok: true }],
}

function html(check: TourCheck, live = true): string {
  return renderToStaticMarkup(<CheckResults check={check} pass={PASS} fail={FAIL} live={live} />)
}

function text(check: TourCheck, live = true): string {
  return html(check, live).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

describe('CheckResults', () => {
  it('says Passed with the pass line, and nothing to prove it', () => {
    const out = text({ rows: [lost('1', true), inIsr], outcome: 'passed', retrying: false })
    expect(out).toContain('Passed')
    expect(out).toContain(PASS)
    expect(out).not.toContain('Another alarm')
    expect(out).not.toContain('alarms_lost')
    expect(html({ rows: [lost('1', true)], outcome: 'passed', retrying: false })).toContain(
      'data-tour-check="pass"',
    )
  })

  it('says Not yet with the rows that did not hold and what the guest had', () => {
    const out = text({ rows: [lost('2', false), inIsr], outcome: 'failed', retrying: true })
    expect(out).toContain('Not yet')
    expect(out).toContain('alarms_lost as u32 == 1')
    expect(out).toContain('alarms_lost is 2')
    // The row that held is not what the reader has to act on.
    expect(out).not.toContain('alarm_in_isr')
    expect(out).not.toContain(PASS)
    const markup = html({ rows: [lost('2', false)], outcome: 'failed', retrying: true })
    expect(markup).toContain('different policy</strong>')
    expect(markup).toContain('data-tour-check="fail"')
  })

  it('lists a row it could not read with the reason, among the failures', () => {
    const missing: TourCheckRow = {
      text: 'drop_oldest as bool == true',
      pass: null,
      values: [{ expr: 'drop_oldest', text: 'no symbol `drop_oldest`', ok: false }],
    }
    const out = text({ rows: [lost('2', false), missing], outcome: 'failed', retrying: false })
    expect(out).toContain('alarms_lost is 2')
    expect(out).toContain('drop_oldest: no symbol `drop_oldest`')
  })

  it('claims neither verdict when nothing could be read', () => {
    const out = text({
      rows: [lost('no symbol `alarms_lost`', null, false)],
      outcome: 'unknown',
      retrying: true,
    })
    expect(out).toContain('Not checked')
    expect(out).toContain('alarms_lost: no symbol `alarms_lost`')
    expect(out).not.toContain('Passed')
    expect(out).not.toContain(PASS)
    expect(out).not.toContain('Another alarm')
    expect(out).not.toContain('Start a sample')
  })

  it('on the mock replay lists every row and says where results come from', () => {
    const rows = [lost('', null), inIsr].map((row) => ({ ...row, pass: null, values: [] }))
    const out = text({ rows, outcome: 'unknown', retrying: false }, false)
    expect(out).toContain('Not checked')
    expect(out).toContain('alarms_lost as u32 == 1')
    expect(out).toContain('alarm_in_isr as u32 == 1')
    expect(out).toContain('Checks read the running guest. Start a sample to see the result.')
    expect(out).not.toContain(PASS)
    expect(out).not.toContain('Another alarm')
    expect(html({ rows, outcome: 'unknown', retrying: false }, false)).toContain(
      'data-tour-check="unread"',
    )
  })
})
