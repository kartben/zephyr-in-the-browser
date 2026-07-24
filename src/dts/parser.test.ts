import { describe, expect, it } from 'vitest'
import { DtsParseError } from './model'
import { parseDts } from './parser'
import { byLabel, byPath, pathOf, prop, stringProp, stringsProp } from './query'
import m3Blinky from './fixtures/qemu_cortex_m3_blinky.dts?raw'
import a53Shell from './fixtures/qemu_cortex_a53_shell.dts?raw'

describe('parseDts', () => {
  it('parses a flattened Cortex-M3 tree', () => {
    const doc = parseDts(m3Blinky)
    expect(doc.root.name).toBe('/')
    expect(stringProp(doc.root, 'model')).toBe('Texas Instruments LM3S6965')

    const gpio = byLabel(doc, 'host_gpio')
    expect(gpio?.name).toBe('gpio@40061000')
    expect(gpio?.unitAddress).toBe('40061000')
    expect(pathOf(gpio!)).toBe('/soc/gpio@40061000')
    expect(byPath(doc, '/soc/gpio@40061000')).toBe(gpio)
  })

  it('indexes every compatible string', () => {
    const doc = parseDts(a53Shell)
    expect(doc.compatIndex.get('virtio,i2c')).toHaveLength(1)
    expect(doc.compatIndex.get('arm,pl011')).toHaveLength(2)
    expect(doc.compatIndex.get('no,such-device')).toBeUndefined()
  })

  it('decodes cells, including refs', () => {
    const doc = parseDts(m3Blinky)
    const led = byLabel(doc, 'led0')!
    expect(prop(led, 'gpios')?.values).toEqual([
      {
        kind: 'cells',
        cells: [
          { kind: 'ref', label: 'host_gpio' },
          { kind: 'number', value: 4 },
          { kind: 'number', value: 0 },
        ],
      },
    ])
  })

  it('decodes byte strings', () => {
    const doc = parseDts(a53Shell)
    const net = byLabel(doc, 'virtio_net0')!
    expect(prop(net, 'local-mac-address')?.values).toEqual([
      { kind: 'bytes', bytes: [0x02, 0, 0, 0, 0, 1] },
    ])
  })

  it('keeps the verbatim value text in raw', () => {
    const doc = parseDts(m3Blinky)
    const led = byLabel(doc, 'led0')!
    expect(prop(led, 'gpios')?.raw).toBe('< &host_gpio 0x4 0x0 >')
    expect(prop(led, 'label')?.raw).toBe('"Host LED0"')
  })

  it('treats boolean properties as present with no values', () => {
    const doc = parseDts(a53Shell)
    const oled = byLabel(doc, 'ssd1306_0')!
    expect(prop(oled, 'segment-remap')).toEqual({ name: 'segment-remap', raw: '', values: [] })
    expect(prop(oled, 'no-such-flag')).toBeUndefined()
  })

  it('handles string lists, multiple labels and packed bytes', () => {
    const doc = parseDts(`
      /dts-v1/;
      / {
        a: b: node@1 {
          compatible = "vendor,chip", "generic-chip";
          data = [0102 03];
        };
      };
    `)
    const node = byLabel(doc, 'a')!
    expect(byLabel(doc, 'b')).toBe(node)
    expect(node.labels).toEqual(['a', 'b'])
    expect(stringsProp(node, 'compatible')).toEqual(['vendor,chip', 'generic-chip'])
    expect(prop(node, 'data')?.values).toEqual([{ kind: 'bytes', bytes: [1, 2, 3] }])
  })

  it('evaluates parenthesized integer expressions in cells', () => {
    const doc = parseDts('/dts-v1/; / { n { p = <(1 << 4) ((2 + 3) * 4) (~0)>; }; };')
    const node = doc.root.children.find((c) => c.name === 'n')!
    expect(prop(node, 'p')?.values).toEqual([
      {
        kind: 'cells',
        cells: [
          { kind: 'number', value: 16 },
          { kind: 'number', value: 20 },
          { kind: 'number', value: 0xffffffff },
        ],
      },
    ])
  })

  it('merges reopened nodes and overlay-style fragments', () => {
    const doc = parseDts(`
      /dts-v1/;
      / { soc { dev: uart@0 { status = "disabled"; }; }; };
      &dev { status = "okay"; extra = <1>; };
      / { soc { other { }; }; };
    `)
    const dev = byLabel(doc, 'dev')!
    expect(stringProp(dev, 'status')).toBe('okay') // last write wins
    expect(prop(dev, 'extra')).toBeDefined()
    expect(doc.root.children).toHaveLength(1) // both / blocks merged
    expect(byPath(doc, '/soc/other')).toBeDefined()
  })

  it('tolerates /memreserve/, /bits/, /omit-if-no-ref/ and /delete-node/', () => {
    const doc = parseDts(`
      /dts-v1/;
      /memreserve/ 0x10000000 0x4000;
      / {
        /omit-if-no-ref/ keep { p = /bits/ 8 <0xff 0x01>; };
        /delete-node/ &gone;
      };
    `)
    const keep = byPath(doc, '/keep')!
    expect(prop(keep, 'p')?.values).toEqual([
      { kind: 'cells', cells: [{ kind: 'number', value: 255 }, { kind: 'number', value: 1 }] },
    ])
  })

  it('reports the failing position', () => {
    try {
      parseDts('/dts-v1/;\n/ {\n  bad bad bad\n};\n')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DtsParseError)
      expect((err as DtsParseError).line).toBe(3)
      expect((err as DtsParseError).message).toMatch(/line 3/)
    }
  })

  it('rejects truncated input', () => {
    expect(() => parseDts('/dts-v1/; / { soc {')).toThrow(DtsParseError)
    expect(() => parseDts('/dts-v1/; / { p = "unterminated; };')).toThrow(DtsParseError)
  })
})
