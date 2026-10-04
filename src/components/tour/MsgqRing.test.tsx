import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MsgqRing } from './MsgqRing'
import type { MsgqRingSnapshot } from '@/debug/kernel/msgqRing'

/**
 * The strip is what a reader of the msg_queue tour looks at to see a ring, so
 * pin what each slot says: its label (what a screen reader hears), what is
 * drawn in it, and whether R or W sits above it.
 */

const BASE = 0x4006_1670

function queue(read: number, write: number, used: number, text: string): MsgqRingSnapshot {
  return {
    msgSize: 1,
    maxMsgs: 10,
    used,
    bufferStart: BASE,
    bufferEnd: BASE + 10,
    readPtr: BASE + read,
    writePtr: BASE + write,
    bytes: new TextEncoder().encode(text),
  }
}

const unescape = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Each slot as the page draws it. */
function slots(html: string) {
  return [...html.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map(([, inner]) => {
    const label = unescape(/<span class="sr-only">(.*?)<\/span>/.exec(inner!)![1]!)
    const visible = unescape(inner!.replace(/<span class="sr-only">.*?<\/span>/, '').replace(/<[^>]+>/g, ' '))
    return {
      label,
      // A slot shows a quoted character, hex or digits, so a bare R or W in a
      // span of its own can only be a pointer marker.
      r: />R<\/span>/.test(inner!),
      w: />W<\/span>/.test(inner!),
      visible: visible.replace(/\s+/g, ' ').trim(),
    }
  })
}

function render(ring: MsgqRingSnapshot) {
  return renderToStaticMarkup(<MsgqRing ring={ring} name="my_msgq" />)
}

describe('MsgqRing', () => {
  it('shows the first put_front: A in the last slot, with R on it', () => {
    // '0' and '1' went in from slot 0, then k_msgq_put_front() wrapped R to 9.
    const html = render(queue(9, 2, 3, '01\0\0\0\0\0\0\0A'))
    const drawn = slots(html)
    expect(drawn).toHaveLength(10)
    expect(drawn[9]).toMatchObject({ label: "slot 9, 'A', next to read", r: true, w: false })
    expect(drawn[0]!.label).toBe("slot 0, '0', read 2nd")
    expect(drawn[1]!.label).toBe("slot 1, '1', read 3rd")
    expect(drawn[2]).toMatchObject({ label: 'slot 2, empty, next to write', r: false, w: true })
    expect(drawn.filter((s) => s.r)).toHaveLength(1)
    expect(html).toContain('3 of 10 used, 1 byte per message')
    expect(html).toContain('aria-label="my_msgq ring buffer"')
    expect(html).toContain('role="list"')
  })

  it('reads 0 1 2 3 4 5 _ C B A after nine messages, with R at slot 7', () => {
    const drawn = slots(render(queue(7, 6, 9, '012345\0CBA')))
    // The character each slot shows, an empty slot drawn empty.
    const strip = drawn.map((s) => /'(.)'/.exec(s.visible)?.[1] ?? '_')
    expect(strip.join(' ')).toBe('0 1 2 3 4 5 _ C B A')
    expect(drawn.findIndex((s) => s.r)).toBe(7)
    expect(drawn.findIndex((s) => s.w)).toBe(6)
    expect(drawn[7]!.label).toBe("slot 7, 'C', next to read")
    expect(drawn[0]!.label).toBe("slot 0, '0', read 4th")
    expect(drawn[6]!.label).toBe('slot 6, empty, next to write')
  })

  it('shows the byte under each character, and a dot for one that does not print', () => {
    const drawn = slots(render(queue(0, 2, 2, 'A\x07')))
    expect(drawn[0]!.visible).toContain("'A' 41")
    expect(drawn[1]!.visible).toContain('· 07')
    expect(drawn[1]!.label).toBe('slot 1, 0x07, read 2nd')
  })

  it('says where both pointers are on a full queue and on an empty one', () => {
    const full = slots(render(queue(4, 4, 10, '0123456789')))
    expect(full[4]).toMatchObject({ label: "slot 4, '4', next to read, write pointer", r: true, w: true })
    const empty = slots(render(queue(4, 4, 0, '0123456789')))
    expect(empty[4]).toMatchObject({ label: 'slot 4, empty, read pointer, next to write', r: true, w: true })
    // An empty slot shows nothing, whatever stale bytes are still behind it.
    expect(empty[3]!.visible).toBe('3')
  })

  it('previews longer messages in hex, with the whole message in words', () => {
    const bytes = new Uint8Array(8 * 16)
    bytes.set([0x2a, 0x00, 0x00, 0x00, 0xe8, 0x03], 16)
    const html = render({
      msgSize: 16,
      maxMsgs: 8,
      used: 2,
      bufferStart: BASE,
      bufferEnd: BASE + 8 * 16,
      readPtr: BASE + 16,
      writePtr: BASE + 48,
      bytes,
    })
    const drawn = slots(html)
    expect(drawn[1]!.visible).toContain('2a 00 00 00 …')
    expect(drawn[1]!.label).toBe('slot 1, 2a 00 00 00 e8 03 00 00 and 8 more bytes, next to read')
    expect(html).toContain('2 of 8 used, 16 bytes per message')
  })

  it('drops the quotes in a strip too narrow for them, but not from the label', () => {
    const drawn = slots(
      render({
        ...queue(5, 5, 16, ''),
        maxMsgs: 16,
        bufferEnd: BASE + 16,
        bytes: new TextEncoder().encode('fghijklmnopabcde'),
      }),
    )
    expect(drawn[0]!.visible).toBe('12 f 66 0')
    expect(drawn[0]!.label).toBe("slot 0, 'f', read 12th")
    expect(drawn[5]!.label).toBe("slot 5, 'k', next to read, write pointer")
  })

  it('marks a message whose bytes were not read rather than inventing them', () => {
    const drawn = slots(render({ ...queue(9, 2, 3, ''), bytes: null }))
    expect(drawn[9]!.label).toBe('slot 9, not read, next to read')
    expect(drawn[9]!.visible).toContain('··')
  })

  it('draws nothing for a queue too big to read at a glance', () => {
    const big: MsgqRingSnapshot = {
      ...queue(0, 0, 0, ''),
      maxMsgs: 100,
      bufferEnd: BASE + 100,
    }
    expect(render(big)).toBe('')
  })
})
