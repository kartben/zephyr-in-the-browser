import { describe, expect, it } from 'vitest'
import { getBoard, sampleSourceAsset } from '@/boards'
import { parseTour } from '@/tours/parse'
import {
  frontMatterSources,
  isShippableSource,
  parseSourceIndex,
  provenance,
  shippedFileNamed,
  shippedPath,
  shippedPathFor,
} from '@/tours/sources'

/** What the image build writes for msg_queue with `sources: [kernel/msg_q.c]`. */
const INDEX = { files: ['main.c', 'zephyr/kernel/msg_q.c'] }

describe('shippedPathFor', () => {
  it('finds a kernel file from the path the container build recorded', () => {
    expect(shippedPathFor('/workdir/zephyr/kernel/msg_q.c', INDEX)).toBe('zephyr/kernel/msg_q.c')
  })

  it('finds it from a CI runner path', () => {
    expect(
      shippedPathFor('/home/runner/work/zephyr-in-the-browser/zephyr-in-the-browser/zephyr/kernel/msg_q.c', INDEX),
    ).toBe('zephyr/kernel/msg_q.c')
  })

  it('finds it from a local workspace, whatever the checkout is called', () => {
    expect(shippedPathFor('/Users/me/zephyrproject/zephyr/kernel/msg_q.c', INDEX)).toBe(
      'zephyr/kernel/msg_q.c',
    )
    expect(shippedPathFor('/src/zephyr-main/kernel/msg_q.c', INDEX)).toBe('zephyr/kernel/msg_q.c')
  })

  it('takes paths the compiler did not tidy: relative, dotted, Windows', () => {
    expect(shippedPathFor('../../kernel/msg_q.c', INDEX)).toBe('zephyr/kernel/msg_q.c')
    expect(shippedPathFor('/workdir/zephyr/kernel/./../kernel/msg_q.c', INDEX)).toBe(
      'zephyr/kernel/msg_q.c',
    )
    expect(shippedPathFor('C:\\zephyrproject\\zephyr\\kernel\\msg_q.c', INDEX)).toBe(
      'zephyr/kernel/msg_q.c',
    )
  })

  it('finds the sample’s own file', () => {
    expect(shippedPathFor('/workdir/zephyr/samples/kernel/msg_queue/src/main.c', INDEX)).toBe('main.c')
  })

  it('lets the longest shared tail settle two files of the same name', () => {
    const index = { files: ['init.c', 'zephyr/kernel/init.c'] }
    expect(shippedPathFor('/workdir/zephyr/kernel/init.c', index)).toBe('zephyr/kernel/init.c')
    expect(shippedPathFor('/workdir/zephyr/samples/foo/src/init.c', index)).toBe('init.c')
  })

  it('finds this repository’s own module files', () => {
    const index = { files: ['main.c', 'zephyr-module/drivers/qemu_host_gpio.c'] }
    expect(shippedPathFor('/repo/zephyr-module/drivers/qemu_host_gpio.c', index)).toBe(
      'zephyr-module/drivers/qemu_host_gpio.c',
    )
  })

  it('has nothing for a file the image did not ship', () => {
    expect(shippedPathFor('/workdir/zephyr/kernel/sched.c', INDEX)).toBeNull()
    // Same basename, different directory: never stand in for it.
    expect(shippedPathFor('/workdir/zephyr/drivers/foo/msg_q.c', INDEX)).toBeNull()
    expect(shippedPathFor('', INDEX)).toBeNull()
  })

  it('declines to guess between two files that match equally well', () => {
    const index = { files: ['zephyr/drivers/a/x.c', 'zephyr-module/drivers/a/x.c'] }
    expect(shippedPathFor('/elsewhere/drivers/a/x.c', index)).toBeNull()
    // …but the directory above settles it when the stop's path has one.
    expect(shippedPathFor('/repo/zephyr-module/drivers/a/x.c', index)).toBe(
      'zephyr-module/drivers/a/x.c',
    )
  })
})

describe('shippedFileNamed', () => {
  it('finds the file an `at:` pattern names, by basename or a longer tail', () => {
    expect(shippedFileNamed('msg_q.c', INDEX)).toBe('zephyr/kernel/msg_q.c')
    expect(shippedFileNamed('kernel/msg_q.c', INDEX)).toBe('zephyr/kernel/msg_q.c')
    expect(shippedFileNamed('MAIN.C', INDEX)).toBe('main.c')
  })

  it('prefers the sample’s own file to a deeper one of the same name', () => {
    expect(shippedFileNamed('main.c', { files: ['zephyr/lib/main.c', 'main.c'] })).toBe('main.c')
  })

  it('has nothing for a file that was not shipped', () => {
    expect(shippedFileNamed('sched.c', INDEX)).toBeNull()
    expect(shippedFileNamed('drivers/msg_q.c', INDEX)).toBeNull()
  })
})

describe('provenance', () => {
  it('says whose code a shipped file is', () => {
    expect(provenance('zephyr/kernel/msg_q.c')).toEqual({
      origin: 'Zephyr kernel',
      path: 'kernel/msg_q.c',
    })
    expect(provenance('zephyr/drivers/gpio/gpio_virtio.c')).toEqual({
      origin: 'Zephyr',
      path: 'drivers/gpio/gpio_virtio.c',
    })
    expect(provenance('zephyr-module/drivers/qemu_host_gpio.c')).toEqual({
      origin: "this page's module",
      path: 'drivers/qemu_host_gpio.c',
    })
    expect(provenance('main.c')).toEqual({ origin: 'this sample', path: 'main.c' })
  })
})

describe('sources: entries', () => {
  it('accepts paths inside the tree and refuses the rest', () => {
    expect(isShippableSource('kernel/msg_q.c')).toBe(true)
    expect(isShippableSource('zephyr-module/drivers/qemu_host_gpio.c')).toBe(true)
    for (const bad of ['', '/etc/passwd', '../x.c', 'kernel/../../x.c', './kernel/msg_q.c', 'kernel//msg_q.c', 'kernel\\msg_q.c']) {
      expect(isShippableSource(bad), bad).toBe(false)
    }
  })

  it('maps each to where the build ships it', () => {
    expect(shippedPath('kernel/msg_q.c')).toBe('zephyr/kernel/msg_q.c')
    expect(shippedPath('zephyr-module/drivers/qemu_host_gpio.c')).toBe(
      'zephyr-module/drivers/qemu_host_gpio.c',
    )
  })

  it('lands under the base sample’s shipped sources, nested', () => {
    const board = getBoard('qemu_cortex_a53')
    expect(sampleSourceAsset(board, 'msg_queue_trace', shippedPath('kernel/msg_q.c'))).toBe(
      'zephyr/qemu_cortex_a53/src/msg_queue/zephyr/kernel/msg_q.c',
    )
  })
})

describe('parseSourceIndex', () => {
  it('reads the list the build writes', () => {
    expect(parseSourceIndex({ files: ['main.c', 'zephyr/kernel/msg_q.c'] })).toEqual(INDEX)
  })

  it('treats anything else as no index at all', () => {
    for (const bad of [null, 'main.c', ['main.c'], {}, { files: 'main.c' }]) {
      expect(parseSourceIndex(bad)).toBeNull()
    }
  })

  it('drops entries that could not be a shipped path', () => {
    expect(parseSourceIndex({ files: ['main.c', '../../secret', '/etc/passwd', 7] })).toEqual({
      files: ['main.c'],
    })
  })
})

describe('frontMatterSources', () => {
  /*
   * The dev server reads `sources:` with this instead of the parser, which it
   * cannot load. The two have to agree, or the dev server ships a different
   * set of files from the one the build would.
   */
  const docs = {
    list: '---\ntour: T\nsources:\n  - kernel/msg_q.c # the kernel side\n  - "kernel/sched.c"\n---\n',
    inline: '---\nsources: kernel/msg_q.c, zephyr-module/drivers/qemu_host_gpio.c\n---\n',
    crlf: '---\r\nsources:\r\n  - kernel/msg_q.c\r\n---\r\n',
    refused: '---\nsources:\n  - /etc/passwd\n  - ../x.c\n  - kernel/msg_q.c\n---\n',
    absent: '---\ntour: T\n---\n',
    none: '## No front matter\n\nsources: kernel/msg_q.c\n',
    both: '---\nsources: kernel/a.c\n  - kernel/b.c\n---\n',
    mapping: '---\nsources:\n  a: kernel/msg_q.c\n---\n',
    twice: '---\nsources: kernel/a.c\nsources: kernel/b.c\n---\n',
  }

  it.each(Object.entries(docs))('reads `%s` the way the parser does', (_, text) => {
    expect(frontMatterSources(text)).toEqual(parseTour(text).sources)
  })

  it('reads the paths themselves', () => {
    expect(frontMatterSources(docs.list)).toEqual(['kernel/msg_q.c', 'kernel/sched.c'])
    expect(frontMatterSources(docs.refused)).toEqual(['kernel/msg_q.c'])
  })
})
