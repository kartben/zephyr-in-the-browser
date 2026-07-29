import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCommand, runCommand } from './commands'

afterEach(() => {
  // Each test registers its own handlers; unsubscribes keep the map clean.
})

describe('commands', () => {
  it('fans out to every registered listener', () => {
    const a = vi.fn()
    const b = vi.fn()
    const ua = registerCommand('restart', a)
    const ub = registerCommand('restart', b)
    runCommand('restart')
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    ua()
    ub()
  })

  it('is a no-op when nothing is registered', () => {
    expect(() => runCommand('open-samples')).not.toThrow()
  })
})
