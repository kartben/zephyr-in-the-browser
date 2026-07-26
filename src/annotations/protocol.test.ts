import { describe, expect, it } from 'vitest'
import {
  decodeRecord,
  encodeRecord,
  encodeSequence,
  OSC_IDENT,
  type AnnotationRecord,
} from './protocol'

describe('decodeRecord', () => {
  it('reads the boot table announcement', () => {
    expect(decodeRecord('v=1;k=ann;a=3;l=57')).toEqual({ kind: 'ann', id: 3, line: 57 })
    expect(decodeRecord('v=1;k=table;n=6')).toEqual({ kind: 'table', count: 6 })
  })

  it('distinguishes show from pause', () => {
    expect(decodeRecord('v=1;k=show;a=2')).toEqual({ kind: 'show', id: 2, pause: false })
    expect(decodeRecord('v=1;k=pause;a=2')).toEqual({ kind: 'show', id: 2, pause: true })
  })

  it('reads reveal, value and end', () => {
    expect(decodeRecord('v=1;k=reveal;t=led')).toEqual({ kind: 'reveal', panel: 'led' })
    expect(decodeRecord('v=1;k=value;a=1;d=gpio%40e000%20pin%204')).toEqual({
      kind: 'value',
      id: 1,
      text: 'gpio@e000 pin 4',
    })
    expect(decodeRecord('v=1;k=end')).toEqual({ kind: 'end' })
  })

  it('reassembles multi-byte UTF-8 from consecutive escapes', () => {
    // The guest escapes byte by byte, so an em dash arrives as three.
    expect(decodeRecord('v=1;k=value;a=0;d=a%E2%80%94b')).toEqual({
      kind: 'value',
      id: 0,
      text: 'a—b',
    })
  })

  it('rejects a version it does not understand', () => {
    expect(decodeRecord('v=2;k=end')).toBeNull()
    expect(decodeRecord('k=end')).toBeNull()
  })

  it('drops unknown record kinds rather than erroring', () => {
    // A newer guest may emit kinds this page predates.
    expect(decodeRecord('v=1;k=somethingnew;a=1')).toBeNull()
  })

  it('rejects malformed payloads', () => {
    expect(decodeRecord('v=1;k=show;a=notanumber')).toBeNull()
    expect(decodeRecord('v=1;k=show')).toBeNull()
    expect(decodeRecord('v=1;=novalue;k=end')).toBeNull()
    expect(decodeRecord('v=1;k=value;a=0;d=%ZZ')).toBeNull()
    expect(decodeRecord('')).toBeNull()
  })

  it('rejects a negative or non-integer id', () => {
    expect(decodeRecord('v=1;k=show;a=-1')).toBeNull()
    expect(decodeRecord('v=1;k=show;a=1.5')).toBeNull()
  })
})

describe('encodeRecord', () => {
  const cases: AnnotationRecord[] = [
    { kind: 'ann', id: 0, line: 27 },
    { kind: 'table', count: 6 },
    { kind: 'show', id: 4, pause: false },
    { kind: 'show', id: 4, pause: true },
    { kind: 'reveal', panel: 'led' },
    { kind: 'value', id: 1, text: 'gpio@e000 pin 4' },
    { kind: 'end' },
  ]

  it.each(cases)('round-trips $kind', (record) => {
    expect(decodeRecord(encodeRecord(record))).toEqual(record)
  })

  it('escapes the field separator so a value cannot forge a field', () => {
    const encoded = encodeRecord({ kind: 'value', id: 0, text: 'a;k=end;b' })
    expect(encoded).not.toContain('a;k=end')
    expect(decodeRecord(encoded)).toEqual({ kind: 'value', id: 0, text: 'a;k=end;b' })
  })

  it('wraps a sequence the way the guest puts it on the wire', () => {
    const seq = encodeSequence({ kind: 'end' })
    expect(seq).toBe(`\x1b]${OSC_IDENT};v=1;k=end\x1b\\`)
  })
})
