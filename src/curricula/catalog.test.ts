import { describe, expect, it } from 'vitest'
import { CURRICULA, loadCurriculumTour } from '@/curricula/catalog'

describe('curricula', () => {
  it('ships one environmental-node path', () => {
    expect(CURRICULA.map((c) => c.id)).toEqual(['env_node'])
  })

  it('parses the environmental-node tour with chapters and desk steps', () => {
    const doc = loadCurriculumTour('env_node')
    expect(doc).not.toBeNull()
    expect(doc!.problems).toEqual([])
    expect(doc!.curriculum).toBe('Environmental node')
    expect(doc!.steps.length).toBeGreaterThanOrEqual(12)
    expect(doc!.steps.length).toBeLessThanOrEqual(15)
    expect(doc!.steps.some((s) => s.file && !s.at)).toBe(true)
    expect(doc!.steps.some((s) => s.at?.includes('sensor_read_async_mempool'))).toBe(true)
    expect(new Set(doc!.steps.map((s) => s.chapter).filter(Boolean)).size).toBeGreaterThanOrEqual(3)
  })
})
