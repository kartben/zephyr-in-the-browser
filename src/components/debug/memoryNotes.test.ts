import { describe, expect, it } from 'vitest'

import {
  badgeFor,
  buildMemoryNotes,
  explainPointer,
  splitName,
  storedAs,
  type PointerInfo,
} from './memoryNotes'
import type { AddressMap, ResolvedAddress } from '@/debug/addressMap'
import type { ZephyrThread } from '@/debug/kernel/threads'

const SEM: ResolvedAddress = {
  kind: 'object',
  name: 'shell_uart_ctx+0x300',
  base: 0x4005_bd20,
  offset: 0,
  size: 48,
  typeCode: 'SEM4',
  typeName: 'Semaphores',
  fields: [{ label: 'Count', value: '1' }],
}
const THREAD: ResolvedAddress = {
  kind: 'object',
  name: 'shell_uart_thread',
  base: 0x4005_b660,
  offset: 0,
  size: 960,
  typeCode: 'THRD',
}
const CORE: ResolvedAddress = {
  kind: 'objectCore',
  name: 'shell_uart_mpsc_buffer+0x38.obj_core',
  base: 0x4005_f408,
  offset: 0,
  size: null,
  typeCode: 'SEM4',
  objectAddr: 0x4005_f3f0,
}

const map: AddressMap = {
  empty: false,
  resolve: (addr) =>
    ({ [SEM.base]: SEM, [THREAD.base]: THREAD, [CORE.base]: CORE })[addr] ?? null,
}

const thread = { addr: THREAD.base, name: 'shell_uart' } as ZephyrThread

/** Little-endian 64-bit words laid out from the window base. */
function words(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8)
  values.forEach((value, i) => {
    for (let b = 0; b < 8; b++) bytes[i * 8 + b] = Math.floor(value / 2 ** (b * 8)) & 0xff
  })
  return bytes
}

describe('splitName', () => {
  it('keeps the part that tells siblings apart out of the ellipsis', () => {
    expect(splitName('shell_uart_ctx+0x300')).toEqual({ head: 'shell_uart_ctx', tail: '+0x300' })
    expect(splitName('fork_objs[1].obj_core')).toEqual({ head: 'fork_objs', tail: '[1].obj_core' })
    expect(splitName('k_sys_work_q')).toEqual({ head: 'k_sys_work_q', tail: '' })
  })

  it('puts the offset into the target on the end of the tail', () => {
    expect(splitName('led', 8)).toEqual({ head: 'led', tail: '+0x8' })
  })

  it('does not split on a leading dot', () => {
    expect(splitName('.bss')).toEqual({ head: '.bss', tail: '' })
  })
})

describe('badgeFor', () => {
  it('names kernel objects by their C type, not the object-core ID', () => {
    expect(badgeFor(SEM)).toBe('k_sem')
    expect(badgeFor(THREAD)).toBe('k_thread')
  })

  it('uses plain words for everything else', () => {
    expect(badgeFor({ ...SEM, kind: 'data', typeCode: undefined })).toBe('var')
    expect(badgeFor({ ...SEM, kind: 'code', typeCode: undefined })).toBe('fn')
    expect(badgeFor({ ...SEM, kind: 'stack', typeCode: undefined })).toBe('stack')
  })
})

describe('buildMemoryNotes', () => {
  const build = (base: number, values: number[]) =>
    buildMemoryNotes({
      base,
      bytes: words(values),
      ptrBytes: 8,
      map,
      threads: [thread],
      follow: () => {},
    }).notes

  it('names a thread the way the Threads tab does', () => {
    const [note] = build(0x4005_bcf0, [THREAD.base])
    expect(note!.label).toEqual({ badge: 'k_thread', head: 'shell_uart', tail: '' })
    expect(note!.tone).toBe('object')
  })

  it('flags a lone word holding its own address without naming it', () => {
    const [self] = build(0x4005_bd20, [0x4005_bd20, 0])
    expect(self!.info.kind).toBe('pointer')
    expect(self!.label).toBeUndefined()
    expect(self!.onFollow).toBeUndefined()
    expect(self!.mark).toBe('dashed')
  })

  it('reads two words holding the first one\'s address as one probably-empty list', () => {
    const notes = build(0x4005_bd20, [0x4005_bd20, 0x4005_bd20])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      offset: 0,
      length: 16,
      tone: 'quiet',
      mark: 'dashed',
      label: { head: 'empty list?' },
      info: { kind: 'list', empty: true, owner: null },
    })
  })

  it('keeps object-core links quiet and ranked below real targets', () => {
    const [core, sem] = build(0x4005_bd38, [CORE.base, SEM.base])
    expect(core!.tone).toBe('quiet')
    expect(core!.rank!).toBeGreaterThan(sem!.rank!)
    expect(core!.label).toMatchObject({ badge: 'k_sem', tail: '+0x38.obj_core' })
  })

  it('marks pointer bytes as not text', () => {
    expect(build(0x4005_bcf0, [THREAD.base])[0]!.quietAscii).toBe(true)
  })
})

describe('the inspector wording', () => {
  const info = (target: ResolvedAddress, extra: Partial<PointerInfo> = {}): PointerInfo => ({
    kind: 'pointer',
    addr: 0x4005_bd28,
    bytes: [0x20, 0xbd, 0x05, 0x40, 0, 0, 0, 0],
    value: target.base + target.offset,
    target,
    self: false,
    ...extra,
  })

  it('says a matching value is probably a pointer, not that it is one', () => {
    expect(explainPointer(info(SEM))).toBe(
      '0x4005bd20 is the address of k_sem shell_uart_ctx+0x300 (48 B), so this word is probably a pointer to it.',
    )
  })

  it('calls a pointer into the middle of something an interior pointer', () => {
    expect(explainPointer(info({ ...SEM, offset: 0x10 }))).toMatch(
      /lands 0x10 bytes into k_sem .*interior pointer/,
    )
  })

  it('does not promise an object-core link lands on the object', () => {
    expect(explainPointer(info(CORE))).toMatch(/\.obj_core member inside k_sem shell_uart_mpsc_buffer\+0x38, not on its start/)
  })

  it('explains a word that holds its own address', () => {
    expect(explainPointer(info(SEM, { self: true }))).toMatch(/list head points at itself when the list is empty/)
  })

  it('spells out the byte order', () => {
    expect(storedAs([0x20, 0xbd, 0x05, 0x40])).toBe(
      'Stored as 20 bd 05 40, lowest byte first (little-endian)',
    )
  })
})
