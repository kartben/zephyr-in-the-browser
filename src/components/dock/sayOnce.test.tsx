import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Cpu } from 'lucide-react'
import { DockRowShell } from './DockRow'
import { Disclosure } from './Disclosure'

/** A row's or a fold's value said once: in the header while closed, in the body while open. */
function row(expanded: boolean, bodyRepeatsBadge: boolean, secondary = 'Network'): string {
  return renderToStaticMarkup(
    <DockRowShell
      dockKey="net"
      icon={Cpu}
      name="Network"
      secondary={secondary}
      badge={<span>192.0.2.1</span>}
      bodyRepeatsBadge={bodyRepeatsBadge}
      expanded={expanded}
      onToggle={() => {}}
    >
      <p>body</p>
    </DockRowShell>,
  )
}

const count = (html: string, text: string) => html.split(text).length - 1

describe('DockRowShell', () => {
  it('keeps the badge while the row is folded', () => {
    expect(count(row(false, true), '192.0.2.1')).toBe(1)
  })

  it('drops the badge while open when the body repeats it', () => {
    const html = row(true, true)
    expect(html).toContain('body')
    expect(count(html, '192.0.2.1')).toBe(0)
  })

  it('keeps an instrument badge open, whose body does not repeat it', () => {
    expect(count(row(true, false), '192.0.2.1')).toBe(1)
  })

  it('does not echo the name as secondary text', () => {
    expect(count(row(false, true), 'Network')).toBe(1)
    expect(row(false, true, 'eth0')).toContain('eth0')
  })
})

describe('Disclosure', () => {
  const fold = (open: boolean) =>
    renderToStaticMarkup(
      <Disclosure title="Status" meta="192.0.2.1" open={open} onToggle={() => {}}>
        <p>192.0.2.1 static</p>
      </Disclosure>,
    )

  it('reads its meta while closed', () => {
    expect(count(fold(false), '192.0.2.1')).toBe(1)
  })

  it('leaves the value to the open section', () => {
    expect(count(fold(true), '192.0.2.1')).toBe(1)
    expect(fold(true)).toContain('192.0.2.1 static')
  })
})
