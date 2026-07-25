import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSourceKind } from '@/virtio/devices/sensors/model'
import type { SensorChip } from '@/virtio/devices/sensors/model'
import * as follow from './followStore'

function fakeChip(address: number, source?: LiveSourceKind) {
  const values: number[] = []
  const chip = {
    address,
    name: `chip@${address.toString(16)}`,
    decl: {
      channels: [
        { key: 'ax', label: 'Accel X', source },
        { key: 'plain', label: 'No source' },
      ],
    },
    setChannel: (key: string, value: number) => {
      if (key === 'ax') values.push(value)
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

describe('followStore', () => {
  it('starts the channel source and drives the chip with no UI mounted', () => {
    const { chip, values } = fakeChip(0x53, 'orientation-x')
    follow.setFollow(chip, 'ax', true)

    expect(follow.isFollowing(chip, 'ax')).toBe(true)
    expect(started).toHaveLength(1)
    expect(started[0].kind).toBe('orientation-x')
    // The push reached the chip even though nothing React-side exists here.
    expect(values).toEqual([4.2])
  })

  it('is idempotent per direction and stops on unfollow', () => {
    const { chip } = fakeChip(0x53, 'orientation-x')
    follow.setFollow(chip, 'ax', true)
    follow.setFollow(chip, 'ax', true)
    expect(started).toHaveLength(1)

    follow.setFollow(chip, 'ax', false)
    expect(started[0].stop).toHaveBeenCalledTimes(1)
    expect(follow.isFollowing(chip, 'ax')).toBe(false)

    follow.setFollow(chip, 'ax', false)
    expect(started[0].stop).toHaveBeenCalledTimes(1)
  })

  it('ignores a follow request for a channel with no source', () => {
    const { chip } = fakeChip(0x48)
    follow.setFollow(chip, 'plain', true)
    expect(follow.isFollowing(chip, 'plain')).toBe(false)
    expect(started).toHaveLength(0)
  })

  it('prunes follows for chips that left the bus', () => {
    const a = fakeChip(0x53, 'orientation-x')
    const b = fakeChip(0x48, 'orientation-y')
    follow.setFollow(a.chip, 'ax', true)
    follow.setFollow(b.chip, 'ax', true)

    follow.pruneFollows([a.chip])

    expect(follow.isFollowing(a.chip, 'ax')).toBe(true)
    expect(follow.isFollowing(b.chip, 'ax')).toBe(false)
    expect(started[1].stop).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers on every transition', () => {
    const { chip } = fakeChip(0x53, 'orientation-x')
    const seen = vi.fn()
    const unsubscribe = follow.subscribe(seen)
    follow.setFollow(chip, 'ax', true)
    follow.setFollow(chip, 'ax', false)
    unsubscribe()
    expect(seen).toHaveBeenCalledTimes(2)
  })
})
