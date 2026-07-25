import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSourceKind } from '@/virtio/devices/sensors/model'
import type { SensorChip } from '@/virtio/devices/sensors/model'
import * as follow from './followStore'

/** A chip with the ADXL shape: three channels riding one orientation source. */
function fakeAccel(address: number) {
  const values = new Map<string, number[]>()
  const chip = {
    address,
    name: `accel@${address.toString(16)}`,
    decl: {
      channels: [
        { key: 'ax', label: 'Accel X', source: 'orientation-x' as LiveSourceKind },
        { key: 'ay', label: 'Accel Y', source: 'orientation-y' as LiveSourceKind },
        { key: 'az', label: 'Accel Z', source: 'orientation-z' as LiveSourceKind },
        { key: 'plain', label: 'No source' },
      ],
    },
    setChannel: (key: string, value: number) => {
      values.set(key, [...(values.get(key) ?? []), value])
    },
  } as unknown as SensorChip
  return { chip, values }
}

let startedKinds: LiveSourceKind[] = []
let orientationStarts = 0
let orientationStops: Array<ReturnType<typeof vi.fn>> = []

beforeEach(() => {
  follow.pruneFollows([])
  startedKinds = []
  orientationStarts = 0
  orientationStops = []
  follow.setLiveSourceStarter((kind, push) => {
    startedKinds.push(kind)
    push(4.2)
    return vi.fn()
  })
  follow.setOrientationGroupStarter((push) => {
    orientationStarts += 1
    const stop = vi.fn()
    orientationStops.push(stop)
    push('orientation-x', 1.1)
    push('orientation-y', 2.2)
    push('orientation-z', 3.3)
    return stop
  })
})

describe('followStore (grouped)', () => {
  it('one orientation toggle starts a single group listener and drives every axis', () => {
    const { chip, values } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)

    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(true)
    expect(orientationStarts).toBe(1)
    expect(startedKinds).toEqual([])
    // All three axes received the projected values; the sourceless channel none.
    expect(values.get('ax')).toEqual([1.1])
    expect(values.get('ay')).toEqual([2.2])
    expect(values.get('az')).toEqual([3.3])
    expect(values.has('plain')).toBe(false)
  })

  it('reports which channels the group drives', () => {
    const { chip } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)
    expect(follow.groupDrivesChannel(chip, 'orientation', 'ax')).toBe(true)
    expect(follow.groupDrivesChannel(chip, 'orientation', 'plain')).toBe(false)
    follow.setFollowGroup(chip, 'orientation', false)
    expect(follow.groupDrivesChannel(chip, 'orientation', 'ax')).toBe(false)
  })

  it('is idempotent per direction and stops the whole set on unfollow', () => {
    const { chip } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)
    follow.setFollowGroup(chip, 'orientation', true)
    expect(orientationStarts).toBe(1)

    follow.setFollowGroup(chip, 'orientation', false)
    expect(orientationStops[0]).toHaveBeenCalledTimes(1)
    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(false)
  })

  it('ignores a group with no member channels', () => {
    const { chip } = fakeAccel(0x48)
    follow.setFollowGroup(chip, 'battery', true)
    expect(follow.isFollowingGroup(chip, 'battery')).toBe(false)
    expect(startedKinds).toHaveLength(0)
    expect(orientationStarts).toBe(0)
  })

  it('prunes follows for chips that left the bus', () => {
    const a = fakeAccel(0x53)
    const b = fakeAccel(0x48)
    follow.setFollowGroup(a.chip, 'orientation', true)
    follow.setFollowGroup(b.chip, 'orientation', true)

    follow.pruneFollows([a.chip])

    expect(follow.isFollowingGroup(a.chip, 'orientation')).toBe(true)
    expect(follow.isFollowingGroup(b.chip, 'orientation')).toBe(false)
    expect(orientationStops[1]).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers on every transition', () => {
    const { chip } = fakeAccel(0x53)
    const fn = vi.fn()
    const off = follow.subscribe(fn)
    follow.setFollowGroup(chip, 'orientation', true)
    follow.setFollowGroup(chip, 'orientation', false)
    expect(fn).toHaveBeenCalledTimes(2)
    off()
  })
})
