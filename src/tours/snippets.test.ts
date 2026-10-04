import { describe, expect, it } from 'vitest'
import {
  isCommandLine,
  parsePlaceholders,
  resolvePlaceholders,
  type SnippetContext,
} from '@/tours/snippets'

/** A guest that has stopped once: a thread walk, and the image's data symbols. */
const GUEST: SnippetContext = {
  threads: [
    { name: 'main', addr: 0x40061000 },
    { name: 'consumer', addr: 0x40062000 },
  ],
  symbols: new Map([
    ['readings', { addr: 0x40050010 }],
    ['_k_thread_obj_sensor', { addr: 0x40063000 }],
    ['_k_thread_obj_consumer', { addr: 0x4006ffff }],
  ]),
}

describe('parsePlaceholders', () => {
  it('finds both kinds', () => {
    const { placeholders, problems } = parsePlaceholders(
      'kernel thread suspend ${thread:consumer}\ndevmem ${addr:readings} 32',
    )
    expect(problems).toEqual([])
    expect(placeholders).toEqual([
      { kind: 'thread', name: 'consumer', raw: '${thread:consumer}' },
      { kind: 'addr', name: 'readings', raw: '${addr:readings}' },
    ])
  })

  it('leaves text with no placeholders alone', () => {
    expect(parsePlaceholders('msgq consumer suspend')).toEqual({ placeholders: [], problems: [] })
  })

  it('reports a kind it does not know', () => {
    const { placeholders, problems } = parsePlaceholders('kernel thread suspend ${thred:consumer}')
    expect(placeholders).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('${thred:consumer}')
    expect(problems[0]).toContain('is not a placeholder')
  })

  it('reports a missing name', () => {
    expect(parsePlaceholders('${thread:}').problems[0]).toContain('names no thread')
    expect(parsePlaceholders('${addr}').problems[0]).toContain('names no symbol')
  })

  it('reports a symbol name no C compiler would emit', () => {
    expect(parsePlaceholders('${addr:my readings}').problems[0]).toContain('is not a symbol name')
  })

  it('reports a missing brace without swallowing the next line', () => {
    const { placeholders, problems } = parsePlaceholders(
      'kernel thread suspend ${thread:consumer\nkernel thread resume ${thread:consumer}',
    )
    expect(problems).toEqual(['`${thread:consumer` has no closing `}`'])
    expect(placeholders).toHaveLength(1)
  })
})

describe('resolvePlaceholders', () => {
  it('fills a thread in from the last walk', () => {
    const resolved = resolvePlaceholders('kernel thread suspend ${thread:consumer}', GUEST)
    expect(resolved.errors).toEqual([])
    // The walk wins over the symbol: it is what the guest has right now.
    expect(resolved.text).toBe('kernel thread suspend 0x40062000')
  })

  it('falls back to the symbol K_THREAD_DEFINE leaves behind', () => {
    expect(resolvePlaceholders('${thread:sensor}', GUEST).text).toBe('0x40063000')
    // Before the first stop there is no walk at all, and that is enough.
    expect(resolvePlaceholders('${thread:consumer}', { ...GUEST, threads: [] }).text).toBe(
      '0x4006ffff',
    )
  })

  it('fills a data symbol in', () => {
    expect(resolvePlaceholders('devmem ${addr:readings}', GUEST).text).toBe('devmem 0x40050010')
  })

  it('says which thread is missing', () => {
    const resolved = resolvePlaceholders('kernel thread suspend ${thread:producer}', GUEST)
    expect(resolved.text).toBeNull()
    expect(resolved.errors).toEqual(['No thread named “producer”'])
  })

  it('says which symbol is missing', () => {
    const resolved = resolvePlaceholders('devmem ${addr:nowhere}', GUEST)
    expect(resolved.text).toBeNull()
    expect(resolved.errors).toEqual(['No symbol “nowhere” in this image'])
  })

  it('says the guest is needed when there is nothing to look in', () => {
    // The mock backend: no image, no walk. Nothing is invented.
    const resolved = resolvePlaceholders('${addr:readings}', { threads: [], symbols: null })
    expect(resolved.text).toBeNull()
    expect(resolved.errors).toEqual(['${addr:readings} needs the running guest'])
  })

  it('refuses a malformed placeholder rather than typing it', () => {
    const resolved = resolvePlaceholders('kernel thread suspend ${thred:consumer}', GUEST)
    expect(resolved.text).toBeNull()
    expect(resolved.errors[0]).toContain('is not a placeholder')
  })

  it('keeps the pieces apart for rendering', () => {
    expect(resolvePlaceholders('suspend ${thread:consumer} ${addr:nowhere}', GUEST).pieces).toEqual([
      { text: 'suspend ', placeholder: null, error: null },
      { text: '0x40062000', placeholder: '${thread:consumer}', error: null },
      { text: ' ', placeholder: null, error: null },
      {
        text: '${addr:nowhere}',
        placeholder: '${addr:nowhere}',
        error: 'No symbol “nowhere” in this image',
      },
    ])
  })
})

describe('isCommandLine', () => {
  it('skips blank lines and comments', () => {
    expect(isCommandLine('msgq stat')).toBe(true)
    expect(isCommandLine('  msgq stat  ')).toBe(true)
    expect(isCommandLine('')).toBe(false)
    expect(isCommandLine('   ')).toBe(false)
    expect(isCommandLine('# stop the consumer first')).toBe(false)
  })
})
