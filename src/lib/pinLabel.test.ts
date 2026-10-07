import { describe, expect, it } from 'vitest'
import { pinDisplayName } from './pinLabel'

describe('pinDisplayName', () => {
  it("drops the overlays' Host and Browser prefix", () => {
    expect(pinDisplayName('Host SW0')).toBe('SW0')
    expect(pinDisplayName('Host LED0')).toBe('LED0')
    expect(pinDisplayName('Browser SW0')).toBe('SW0')
    expect(pinDisplayName('Browser LED0')).toBe('LED0')
  })

  it("leaves a board's own labels as they are", () => {
    expect(pinDisplayName('User SW1')).toBe('User SW1')
    expect(pinDisplayName('BOOT Button')).toBe('BOOT Button')
    expect(pinDisplayName('SW0')).toBe('SW0')
    // Only the overlay's capitalised word, and only in front.
    expect(pinDisplayName('host_led')).toBe('host_led')
    expect(pinDisplayName('LED on Host')).toBe('LED on Host')
  })

  it('keeps a label that would be empty without it', () => {
    expect(pinDisplayName('Host')).toBe('Host')
    expect(pinDisplayName('Host ')).toBe('Host ')
  })
})
