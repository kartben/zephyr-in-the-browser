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

let started: Array<{ kind: LiveSourceKind; stop: ReturnType<typeof vi.fn> }> = []

beforeEach(() => {
  follow.pruneFollows([])
  started = []
  follow.setLiveSourceStarter((kind, push) => {
    const stop = vi.fn()
    started.push({ kind, stop })
    push(4.2)
    return stop
  })
})

describe('followStore (grouped)', () => {
  it('one toggle starts every channel of the group and drives the chip', () => {
    const { chip, values } = fakeAccel(0x53)
    follow.setFollowGroup(chip, 'orientation', true)

    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(true)
    expect(started.map((s) => s.kind)).toEqual([
      'orientation-x',
      'orientation-y',
      'orientation-z',
    ])
    // All three axes received the pushed value; the sourceless channel none.
    expect(values.get('ax')).toEqual([4.2])
    expect(values.get('ay')).toEqual([4.2])
    expect(values.get('az')).toEqual([4.2])
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
    expect(started).toHaveLength(3)

    follow.setFollowGroup(chip, 'orientation', false)
    for (const s of started) expect(s.stop).toHaveBeenCalledTimes(1)
    expect(follow.isFollowingGroup(chip, 'orientation')).toBe(false)
  })

  it('ignores a group with no member channels', () => {
    const { chip } = fakeAccel(0x48)
    follow.setFollowGroup(chip, 'battery', true)
    expect(follow.isFollowingGroup(chip, 'battery')).toBe(false)
    expect(started).toHaveLength(0)
  })

  it('prunes follows for chips that left the bus', () => {
    const a = fakeAccel(0x53)
    const b = fakeAccel(0x48)
    follow.setFollowGroup(a.chip, 'orientation', true)
    follow.setFollowGroup(b.chip, 'orientation', true)

    follow.pruneFollows([a.chip])

    expect(follow.isFollowingGroup(a.chip, 'orientation')).toBe(true)
    expect(follow.isFollowingGroup(b.chip, 'orientation')).toBe(false)
    // b's three subscriptions all stopped.
    for (const s of started.slice(3)) expect(s.stop).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers on every transition', () => {
    const { chip } = fakeAccel(0x53)
    const seen = vi.fn()
    const unsubscribe = follow.subscribe(seen)
    follow.setFollowGroup(chip, 'orientation', true)
    follow.setFollowGroup(chip, 'orientation', false)
    unsubscribe()
    expect(seen).toHaveBeenCalledTimes(2)
  })
})
