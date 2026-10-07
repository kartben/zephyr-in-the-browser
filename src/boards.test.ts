import { describe, expect, it } from 'vitest'

import { BOARDS, getBoard, getSample, sampleForSeed } from '@/boards'
import { sampleDocs } from '@/sampleDocs'

describe('sampleForSeed', () => {
  it('finds the sample a board:sample seed names', () => {
    expect(sampleForSeed('qemu_cortex_a53:magic_wand')?.id).toBe('magic_wand')
    expect(sampleForSeed('qemu_cortex_m3:blinky')?.id).toBe('blinky')
  })

  it('does not swap an unknown or foreign seed for a default', () => {
    expect(sampleForSeed('qemu_cortex_a53:no_such_app')).toBeNull()
    expect(sampleForSeed('qemu_riscv32:magic_wand')).toBeNull()
    expect(sampleForSeed('live')).toBeNull()
    expect(sampleForSeed('custom:zephyr.elf:')).toBeNull()
    expect(sampleForSeed('')).toBeNull()
  })
})

describe('Magic Wand', () => {
  const a53 = getBoard('qemu_cortex_a53')

  it('offers its gestures on the plain and the traced build', () => {
    expect(getSample(a53, 'magic_wand').recordings).toBe('magic-wand')
    const traced = getSample(a53, 'magic_wand_trace')
    expect(traced.tracedFrom).toBe('magic_wand')
    expect(traced.recordings).toBe('magic-wand')
  })

  it('links the upstream sample docs, though it builds the fork', () => {
    const docs = sampleDocs(getSample(a53, 'magic_wand'), null)
    expect(docs.canonicalHref).toBe(
      'https://docs.zephyrproject.org/latest/samples/modules/tflite-micro/magic_wand/README.html',
    )
  })

  it('stays off the boards too slow for float inference', () => {
    const others = BOARDS.filter((board) => board.id !== 'qemu_cortex_a53')
    for (const board of others) {
      expect(board.samples.some((s) => s.id.startsWith('magic_wand'))).toBe(false)
    }
  })
})

describe('Trace on open', () => {
  /** Samples whose own prj.conf writes a trace, so they have no `_trace` twin. */
  const TRACED_ITSELF = new Set(['tracing', 'tracing_pipeline'])

  it('opens only on builds that write a trace', () => {
    for (const board of BOARDS) {
      for (const sample of board.samples) {
        if (!sample.primaryPanels?.includes('trace')) continue
        const traced = sample.tracedFrom !== undefined || TRACED_ITSELF.has(sample.id)
        expect(traced, `${board.id}:${sample.id} opens Trace on a build without one`).toBe(true)
      }
    }
  })

  it('still opens on the traced twins of the net samples, beside Network', () => {
    const a53 = getBoard('qemu_cortex_a53')
    for (const id of ['dhcp', 'http_server', 'echo_server', 'http_get']) {
      expect(getSample(a53, id).primaryPanels).not.toContain('trace')
      const twin = getSample(a53, `${id}_trace`).primaryPanels ?? []
      expect(twin).toContain('net')
      expect(twin).toContain('trace')
      expect(twin).toContain('debug')
    }
  })
})
