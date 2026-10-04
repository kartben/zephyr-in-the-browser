import { describe, expect, it } from 'vitest'

import magicWand from './magicWand.json'
import { RECORDING_SETS } from '.'

/*
 * magicWand.json is generated (tools/extract-magic-wand-gestures.py), which
 * proves each clip against the model. What is worth pinning here is the shape
 * the replay relies on, so a hand edit or a bad regeneration fails fast.
 */

const set = RECORDING_SETS['magic-wand']

describe('magic wand recordings', () => {
  it('says where they come from and under which licence', () => {
    expect(magicWand.license).toBe('Apache-2.0')
    expect(magicWand.source).toMatch(/^https:\/\/github\.com\/antmicro\/zephelin\/tree\/[0-9a-f]{40}\//)
    expect(magicWand.unit).toBe('g')
    expect(set.target).toBe('adxl345')
  })

  it('has one clip per gesture the guest names', () => {
    expect(set.clips.map((clip) => clip.id)).toEqual(['wing', 'ring', 'slope'])
    expect(set.clips.map((clip) => clip.label)).toEqual(['Wing', 'Ring', 'Slope'])
  })

  it('holds a full model window per clip, at 25 Hz', () => {
    expect(set.rateHz).toBe(25)
    for (const clip of set.clips) {
      expect(clip.samples.length).toBeGreaterThanOrEqual(128)
      expect(clip.samples.length / set.rateHz).toBeLessThan(8)
    }
  })

  it('starts and ends every clip at rest, flat on the desk', () => {
    expect(set.rest).toEqual([0, 0, 1])
    for (const clip of set.clips) {
      expect(clip.samples[0]).toEqual(set.rest)
      expect(clip.samples.at(-1)).toEqual(set.rest)
    }
  })

  it('stays inside the ±8 g the driver configures', () => {
    for (const clip of set.clips) {
      for (const sample of clip.samples) {
        expect(sample).toHaveLength(3)
        for (const g of sample) {
          expect(Number.isFinite(g)).toBe(true)
          expect(Math.abs(g)).toBeLessThan(8)
        }
      }
    }
  })
})
