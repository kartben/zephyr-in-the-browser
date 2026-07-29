import { describe, expect, it } from 'vitest'
import { browseFat, isBlankDisk, readFatGeometry } from './fatBrowse'
import fixture from './fixtures/virtio-blk-fat12.json'
import type { FsTreeFile } from './fsTree'

/**
 * The fixture is a real image: FatFS f_mkfs() output from
 * zephyr-module/apps/virtio_blk_fs running on qemu_cortex_a53 over the
 * vendored virtio,blk driver, dumped out of the emulator's MEMFS. Testing
 * against what Zephyr actually writes is the point — a hand-rolled image would
 * only prove the reader agrees with whatever the test author assumed.
 */
function rehydrate(): Uint8Array {
  const image = new Uint8Array(fixture.totalBytes)
  for (const [index, b64] of Object.entries(fixture.sectors)) {
    const bin = atob(b64)
    const at = Number(index) * fixture.sectorSize
    for (let i = 0; i < bin.length; i++) image[at + i] = bin.charCodeAt(i)
  }
  return image
}

function fileNamed(nodes: ReturnType<typeof browseFat>, name: string) {
  return nodes?.root.children.find((n): n is FsTreeFile => n.kind === 'file' && n.name === name)
}

describe('isBlankDisk', () => {
  it('calls an all-zero image blank', () => {
    expect(isBlankDisk(new Uint8Array(4096))).toBe(true)
  })

  it('calls a shorter-than-a-sector image blank', () => {
    expect(isBlankDisk(new Uint8Array(16))).toBe(true)
  })

  it('recognises a formatted image by its boot signature', () => {
    expect(isBlankDisk(rehydrate())).toBe(false)
  })
})

describe('readFatGeometry', () => {
  it('derives FAT12 from the cluster count, not from anything on disk', () => {
    const geom = readFatGeometry(rehydrate())
    expect(geom).not.toBeNull()
    // 8192 total sectors, 1 reserved + 1 FAT x 7 + 32 root dir = 40 data start,
    // (8192 - 40) / 4 = 2038 clusters, which is < 4085 so FAT12.
    expect(geom).toMatchObject({
      kind: 'FAT12',
      bytesPerSector: 512,
      sectorsPerCluster: 4,
      clusterCount: 2038,
    })
  })

  it('returns null rather than throwing on a non-FAT image', () => {
    expect(readFatGeometry(new Uint8Array(4096).fill(0x5a))).toBeNull()
  })
})

describe('browseFat', () => {
  it('returns null for an unformatted image', () => {
    expect(browseFat(new Uint8Array(4096))).toBeNull()
    expect(browseFat(new Uint8Array(0))).toBeNull()
  })

  it('lists the files the guest created, with 8.3 names', () => {
    const result = browseFat(rehydrate())
    expect(result?.error).toBeUndefined()
    expect(result?.root.children.map((n) => n.name).sort()).toEqual(['BOOT.CNT', 'SESSION.LOG'])
  })

  it('reads the boot counter the guest wrote', () => {
    const boot = fileNamed(browseFat(rehydrate()), 'BOOT.CNT')
    expect(boot?.size).toBe(4)
    // The sample writes a uint32 little-endian; this dump is from boot 1.
    expect(new DataView(boot!.content.buffer, boot!.content.byteOffset).getUint32(0, true)).toBe(1)
  })

  it('truncates a file to its recorded size, not its last whole cluster', () => {
    const log = fileNamed(browseFat(rehydrate()), 'SESSION.LOG')
    // The final cluster still holds bytes from an earlier, longer write; the
    // directory entry's size is what bounds the file.
    expect(log?.size).toBe(0x5d1)
    expect(log?.content.length).toBe(0x5d1)
    const text = new TextDecoder().decode(log!.content)
    expect(text.startsWith('00000000 uptime=3220ms\n')).toBe(true)
    expect(text.endsWith('00000060 uptime=183820ms\n')).toBe(true)
    expect(text.split('\n').filter(Boolean)).toHaveLength(61)

    // Prove the truncation is doing work: the cluster really does continue
    // past the file, with the tail of a longer earlier write still in it.
    const image = rehydrate()
    const clusterTail = new TextDecoder().decode(image.subarray(46 * 512, 47 * 512))
    expect(clusterTail.endsWith('me=123620ms\n00000041 uptime=126630ms\n00000042 u')).toBe(true)
  })

  it('reports the geometry in its summary line', () => {
    expect(browseFat(rehydrate())?.summary).toBe(
      'FAT12 · 2038 × 2048 B clusters · 512 B sectors',
    )
  })

  it('collects every file into the flat list the browser dialog indexes', () => {
    const result = browseFat(rehydrate())
    expect(result?.files.map((f) => f.path).sort()).toEqual(['/BOOT.CNT', '/SESSION.LOG'])
  })
})
