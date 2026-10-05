/**
 * The parameter names the register tooltips put on the argument registers,
 * end to end: an image with DWARF, a stop in one of its functions, and the
 * names published with the registers.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as hostGdb from '@/hostGdb'
import { AT, FORM, TAG } from '@/debug/dwarf/constants'
import { assembleUnit, makeElf } from '@/debug/dwarf/testing/dwarfBuilder'
import { FakeRspServer } from '@/debug/gdb/testing/fakeRspServer'

/** `int filter(int *s, int gain)` at 0x1000..0x1040. */
function image(): Uint8Array {
  const { info, abbrev } = assembleUnit({
    tag: TAG.compile_unit,
    attrs: [
      [AT.name, FORM.string, 'filter.c'],
      [AT.low_pc, FORM.addr, 0x1000],
      [AT.high_pc, FORM.data4, 0x40],
    ],
    children: [
      {
        tag: TAG.subprogram,
        attrs: [[AT.name, FORM.string, 'filter'], [AT.low_pc, FORM.addr, 0x1000], [AT.high_pc, FORM.data4, 0x40]],
        children: [
          { tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 's']] },
          { tag: TAG.formal_parameter, attrs: [[AT.name, FORM.string, 'gain']] },
        ],
      },
    ],
  })
  return makeElf({ '.debug_info': info, '.debug_abbrev': abbrev })
}

afterEach(() => {
  hostGdb.detach()
})

describe('hostGdb register tooltips', () => {
  it('publishes the parameter names of the function the guest stopped in', async () => {
    // The image is set before binding, as the QEMU backend does: the rebind
    // has to keep it.
    hostGdb.setKernelImage(image())
    hostGdb.bindLive('arm')
    const server = new FakeRspServer({ pc: 0x1010 })
    expect(await hostGdb.attachLiveSession(server.transport())).toBe(true)
    await hostGdb.pause()
    expect(hostGdb.getSnapshot().regFormals).toEqual(['s', 'gain'])
  })

  it('drops them at a stop outside any function', async () => {
    hostGdb.setKernelImage(image())
    hostGdb.bindLive('arm')
    const server = new FakeRspServer({ pc: 0x1010 })
    await hostGdb.attachLiveSession(server.transport())
    await hostGdb.pause()
    expect(hostGdb.getSnapshot().regFormals).toEqual(['s', 'gain'])

    await hostGdb.resume()
    server.pc = 0x3000
    await hostGdb.pause()
    const snap = hostGdb.getSnapshot()
    expect(snap.pc).toBe('00003000')
    expect(snap.regFormals).toEqual([])
  })
})
