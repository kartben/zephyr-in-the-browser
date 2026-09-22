import { describe, expect, it } from 'vitest'
import { JSPI_UNSUPPORTED_MESSAGE, supportsJspi } from './jspi'

/** A host whose WebAssembly namespace has exactly the given members. */
const host = (wasm?: Record<string, unknown>) => (wasm ? { WebAssembly: wasm } : {})

const Suspending = class {}
const promising = () => {}

describe('supportsJspi', () => {
  it('is supported when both Suspending and promising are functions', () => {
    expect(supportsJspi(host({ Suspending, promising }))).toBe(true)
  })

  it('is unsupported when Suspending is missing', () => {
    expect(supportsJspi(host({ promising }))).toBe(false)
  })

  it('is unsupported when promising is missing', () => {
    expect(supportsJspi(host({ Suspending }))).toBe(false)
  })

  it('is unsupported when either is present but not callable', () => {
    expect(supportsJspi(host({ Suspending: {}, promising }))).toBe(false)
    expect(supportsJspi(host({ Suspending, promising: true }))).toBe(false)
  })

  it('is unsupported when WebAssembly is absent', () => {
    expect(supportsJspi(host())).toBe(false)
    expect(supportsJspi({ WebAssembly: undefined })).toBe(false)
  })

  it('probes globalThis by default', () => {
    expect(supportsJspi()).toBe(supportsJspi(globalThis))
  })
})

describe('JSPI_UNSUPPORTED_MESSAGE', () => {
  it('names the first browser releases that ship JSPI', () => {
    for (const needle of ['Chrome', 'Edge 137', 'Firefox 153', 'Safari 27']) {
      expect(JSPI_UNSUPPORTED_MESSAGE).toContain(needle)
    }
  })
})
