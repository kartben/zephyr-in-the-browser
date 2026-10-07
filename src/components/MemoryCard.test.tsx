// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EraseControl } from './MemoryCard'

// React only flushes `act()` updates synchronously when told it is under test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no "${label}" button in: ${host.textContent}`)
  return found
}

describe('EraseControl', () => {
  it('asks before it erases, naming how much goes', () => {
    const onErase = vi.fn()
    act(() => root.render(<EraseControl size={1024 * 1024} onErase={onErase} />))
    act(() => button('erase').click())
    expect(onErase).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Erase all 1 MiB?')
    act(() => button('Erase').click())
    expect(onErase).toHaveBeenCalledTimes(1)
    // Back to the plain link, ready for next time.
    expect(button('erase')).toBeTruthy()
  })

  it('backs out on Cancel without erasing', () => {
    const onErase = vi.fn()
    act(() => root.render(<EraseControl size={256} onErase={onErase} />))
    act(() => button('erase').click())
    act(() => button('Cancel').click())
    expect(onErase).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Erase all')
  })

  it('backs out on Escape, and leaves the focus on Cancel rather than Erase', () => {
    const onErase = vi.fn()
    act(() => root.render(<EraseControl size={256} onErase={onErase} />))
    act(() => button('erase').click())
    expect(document.activeElement?.textContent).toBe('Cancel')
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(onErase).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Erase all')
  })
})
