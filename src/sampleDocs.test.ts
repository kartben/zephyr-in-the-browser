import { describe, expect, it } from 'vitest'
import { sampleDocs } from '@/sampleDocs'
import type { DocsManifest } from '@/sampleDocs'
import type { GuestSample } from '@/boards'

const sample: GuestSample = {
  id: 'hello',
  label: 'Hello World',
  description: 'Prints one line and stops',
  zephyrSample: 'samples/hello_world',
}

const local: GuestSample = {
  id: 'accel',
  label: 'Accelerometer Chart',
  description: 'Browser accelerometer on LVGL',
  zephyrSample: 'zephyr-module/apps/accelerometer_chart',
}

const manifest: DocsManifest = {
  generated: '2026-07-26',
  samples: {
    'samples/hello_world': {
      app: 'hello',
      boards: ['qemu_cortex_m3'],
      title: 'Hello World',
      description: 'Print "Hello World" to the console.',
      local: 'samples/hello_world/README.html',
    },
  },
}

describe('sampleDocs', () => {
  it('prefers Zephyr docs title and description when the mirror has them', () => {
    const docs = sampleDocs(sample, manifest)
    expect(docs.title).toBe('Hello World')
    expect(docs.description).toBe('Print "Hello World" to the console.')
    expect(docs.localHref).toMatch(/docs\/samples\/hello_world\/README\.html$/)
    expect(docs.canonicalHref).toContain('docs.zephyrproject.org')
    expect(docs.sourceHref).toContain('github.com/zephyrproject-rtos/zephyr')
  })

  it('falls back to boards.ts label and description without a manifest', () => {
    const docs = sampleDocs(sample, null)
    expect(docs.title).toBe('Hello World')
    expect(docs.description).toBe('Prints one line and stops')
    expect(docs.localHref).toBeUndefined()
    expect(docs.canonicalHref).toContain('samples/hello_world')
  })

  it('skips upstream links for repo-local zephyr-module samples', () => {
    const docs = sampleDocs(local, null)
    expect(docs.title).toBe('Accelerometer Chart')
    expect(docs.canonicalHref).toBeUndefined()
    expect(docs.sourceHref).toBeUndefined()
  })
})
