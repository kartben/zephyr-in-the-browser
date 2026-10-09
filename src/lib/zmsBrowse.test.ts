import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findZmsVolumes, readZms, type ZmsVolume } from './zmsBrowse'

/**
 * The fixtures were written by Zephyr's own ZMS and settings code on qemu_x86
 * (tools/zms-fixtures), 4 sectors of 1 KiB each:
 *
 * - zms-raw: ids 1 ("round N") and 2 (N, a u32) rewritten for N = 0..69, id 3
 *   written 20 times then deleted, id 4 and 0x12345678 written once at the
 *   start, so garbage collection has to carry them over.
 * - zms-id64-raw: the same writes with CONFIG_ZMS_ID_64BIT.
 * - zms-settings: settings on ZMS: app/name, app/boots saved 3 times,
 *   kite_rush/scores, and tmp/gone saved then deleted.
 */
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}.bin`, import.meta.url)))
}

function read(image: Uint8Array): ZmsVolume {
  const volume = readZms(image, { offset: 0, size: image.length }, 1024)
  expect(volume).not.toBeNull()
  return volume!
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0$/, '')
const u32 = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)

describe.each([
  ['zms-raw', 32],
  ['zms-id64-raw', 64],
] as const)('%s', (name, idBits) => {
  const volume = read(fixture(name))
  const entry = (id: number) => volume.entries.find((e) => e.id === BigInt(id))!

  it('finds the geometry and the open sector', () => {
    expect(volume).toMatchObject({ sectorSize: 1024, sectorCount: 4, ateSize: 16, idBits, version: 1 })
    expect(volume.sectors.map((s) => s.state)).toEqual(['open', 'spare', 'closed', 'closed'])
  })

  it('reads back what the last writes stored', () => {
    expect(text(entry(1).live!.bytes)).toBe('round 69')
    expect(u32(entry(2).live!.bytes)).toBe(69)
    expect(text(entry(4).live!.bytes)).toBe('keep me')
    expect([...entry(0x12345678).live!.bytes]).toEqual(Array.from({ length: 200 }, (_, i) => i))
  })

  it('orders versions newest first across sectors', () => {
    // Every surviving copy of id 2, newest first, counts down one round at a
    // time, through the open sector and both closed ones.
    const values = entry(2).versions.map((v) => u32(v.bytes))
    expect(values[0]).toBe(69)
    values.forEach((v, i) => expect(v).toBe(69 - i))
    expect(new Set(entry(2).versions.map((v) => v.sector))).toEqual(new Set([0, 2, 3]))
  })

  it('reports a delete', () => {
    const deleted = entry(3)
    expect(deleted.live).toBeNull()
    expect(deleted.versions[0]!.deleted).toBe(true)
    expect(deleted.versions.slice(1).every((v) => !v.deleted && v.len === 40)).toBe(true)
  })

  it('has no settings view', () => {
    expect(volume.settings).toBeNull()
  })
})

describe('settings on ZMS', () => {
  const volume = read(fixture('zms-settings'))
  const key = (name: string) => volume.settings!.keys.find((k) => k.name === name)!

  it('names every key, deleted ones included', () => {
    expect(volume.settings!.keys.map((k) => k.name)).toEqual([
      'app/boots',
      'app/name',
      'kite_rush/scores',
      'tmp/gone',
    ])
  })

  it('reads values and their history', () => {
    expect(text(key('app/name').live!.bytes)).toBe('zephyr')
    expect(key('app/boots').versions.map((v) => u32(v.bytes))).toEqual([3, 2, 1])
    expect(key('kite_rush/scores').live!.bytes).toHaveLength(64)
    expect(key('tmp/gone').live).toBeNull()
  })

  it('tells the bookkeeping ids apart', () => {
    const { roles } = volume.settings!
    const boots = key('app/boots')
    expect(roles.get(BigInt(boots.nameId))).toEqual({ kind: 'name', key: 'app/boots' })
    expect(roles.get(BigInt(boots.valueId))).toEqual({ kind: 'value', key: 'app/boots' })
    expect(roles.get(BigInt((boots.nameId | 1) >>> 0))).toEqual({ kind: 'list', key: 'app/boots' })
    expect(roles.get(0x80000000n)).toEqual({ kind: 'head' })
  })

  it('leaves the sectors it never opened erased', () => {
    expect(volume.sectors.map((s) => s.state)).toEqual(['open', 'erased', 'erased', 'erased'])
  })
})

describe('detection', () => {
  it('ignores blank and foreign flash', () => {
    expect(findZmsVolumes(new Uint8Array(8192).fill(0xff), [], 1024)).toEqual([])
    const noise = new Uint8Array(8192).map((_, i) => (i * 37 + 11) & 0xff)
    expect(findZmsVolumes(noise, [], 1024)).toEqual([])
  })

  it('finds a store inside a partition', () => {
    const image = new Uint8Array(0x20000).fill(0xff)
    image.set(fixture('zms-settings'), 0x10000)
    const volumes = findZmsVolumes(image, [{ offset: 0x10000, size: 0x1000 }], 1024)
    expect(volumes).toHaveLength(1)
    expect(volumes[0]!.offset).toBe(0x10000)
    expect(volumes[0]!.settings!.keys).toHaveLength(4)
  })

  it('falls back to the previous version when the newest ATE is corrupt', () => {
    const image = fixture('zms-raw')
    const newest = read(image).entries.find((e) => e.id === 2n)!.versions[0]!
    image[newest.ateAddress + 8]! ^= 0xff
    const after = read(image).entries.find((e) => e.id === 2n)!
    expect(u32(after.live!.bytes)).toBe(68)
  })
})

describe('a store smaller than its partition', () => {
  it('wraps after the last sector the store opened', () => {
    // samples/subsys/kvss/zms mounts 3 sectors of a larger storage_partition.
    // The raw fixture's 4 sectors at the start of a 16-sector partition must
    // still read newest first, wrapping from sector 3 back to sector 0.
    const image = new Uint8Array(16 * 1024).fill(0xff)
    image.set(fixture('zms-raw'), 0)
    const volume = read(image)
    expect(volume.sectorCount).toBe(16)
    expect(volume.openSector).toBe(0)
    expect(volume.sectors.slice(4).every((s) => s.state === 'erased')).toBe(true)
    const two = volume.entries.find((e) => e.id === 2n)!
    two.versions.forEach((v, i) => expect(u32(v.bytes)).toBe(69 - i))
  })
})
