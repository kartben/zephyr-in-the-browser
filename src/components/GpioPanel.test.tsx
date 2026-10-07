// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * A stand-in for hostGpio: one key and one LED, with the press and the LED's
 * output level held here, and listeners told when either changes, the way
 * the real store tells the dock.
 */
const gpio = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    buttons: [{ id: 0, label: 'Host SW0', flags: 0 }],
    leds: [{ id: 4, label: 'Host LED0', flags: 0 }],
    pressed: new Set<number>(),
    lit: new Set<number>(),
  }
  const notify = () => listeners.forEach((fn) => fn())
  return {
    state,
    notify,
    module: {
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      getButtons: () => state.buttons,
      getLeds: () => state.leds,
      isPressed: (id: number) => state.pressed.has(id),
      isOutputHigh: (id: number) => state.lit.has(id),
      setPressed: vi.fn((id: number, down: boolean) => {
        if (down) state.pressed.add(id)
        else state.pressed.delete(id)
        notify()
      }),
      isInputHigh: () => false,
      claimedPinsToken: () => '',
      getClaimedPins: () => [],
      getNgpios: () => 8,
    },
  }
})
vi.mock('@/hostGpio', () => gpio.module)

import { GpioKeysBody, GpioLedsBody } from './GpioPanel'

// React only flushes `act()` updates synchronously when told it is under test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  gpio.state.pressed.clear()
  gpio.state.lit.clear()
  gpio.module.setPressed.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const pointer = (type: string) => new PointerEvent(type, { bubbles: true, pointerId: 1 })

describe('GpioKeysBody', () => {
  it('draws a key named without the host prefix, and no bare 0 or 1', () => {
    act(() => root.render(<GpioKeysBody />))
    const key = host.querySelector('button')!
    // Synthetic presses and readers find it by this name.
    expect(key.getAttribute('aria-label')).toBe('SW0 (pin 0)')
    expect(key.getAttribute('aria-pressed')).toBe('false')
    // The devicetree label as written stays in the tooltip.
    expect(key.title).toContain('Host SW0')
    expect(key.textContent).toBe('SW0press')
    expect(key.textContent).not.toMatch(/\d$/)
  })

  it('stays pressed for as long as the pointer is down', () => {
    act(() => root.render(<GpioKeysBody />))
    const key = host.querySelector('button')!
    act(() => {
      key.dispatchEvent(pointer('pointerdown'))
    })
    expect(gpio.module.setPressed).toHaveBeenLastCalledWith(0, true)
    expect(key.getAttribute('aria-pressed')).toBe('true')
    expect(key.textContent).toBe('SW0pressed')
    act(() => {
      key.dispatchEvent(pointer('pointerup'))
    })
    expect(gpio.module.setPressed).toHaveBeenLastCalledWith(0, false)
    expect(key.getAttribute('aria-pressed')).toBe('false')
  })

  it('holds on Space until the key comes back up', () => {
    act(() => root.render(<GpioKeysBody />))
    const key = host.querySelector('button')!
    act(() => {
      key.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    expect(key.getAttribute('aria-pressed')).toBe('true')
    act(() => {
      key.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
    })
    expect(key.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('GpioLedsBody', () => {
  it('draws a lamp, not a button, and says whether it is lit', () => {
    act(() => root.render(<GpioLedsBody />))
    expect(host.querySelector('button')).toBeNull()
    const lamp = host.querySelector('[title]')!
    expect(lamp.getAttribute('title')).toBe('Host LED0 (pin 4) off')
    expect(lamp.textContent).toBe('LED0, off')

    act(() => {
      gpio.state.lit.add(4)
      gpio.notify()
    })
    expect(lamp.getAttribute('title')).toBe('Host LED0 (pin 4) on')
    expect(lamp.textContent).toBe('LED0, on')
  })
})
