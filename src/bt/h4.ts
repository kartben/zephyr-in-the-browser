/**
 * H:4 HCI packet framing over a raw byte pipe.
 *
 * Packet layout matches Bluetooth Core Spec Host Controller Interface:
 *   CMD  0x01 | opcode le16 | plen u8  | payload
 *   ACL  0x02 | handle le16 | dlen le16 | payload
 *   SCO  0x03 | handle le16 | dlen u8  | payload
 *   EVT  0x04 | event u8    | plen u8  | payload
 *   ISO  0x05 | handle le16 | dlen le16 | payload
 */

export const H4_CMD = 0x01
export const H4_ACL = 0x02
export const H4_SCO = 0x03
export const H4_EVT = 0x04
export const H4_ISO = 0x05

export class H4Framer {
  #buf = new Uint8Array(0)

  /** Push raw UART bytes; returns zero or more complete HCI packets (with type). */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length === 0) return []
    const merged = new Uint8Array(this.#buf.length + chunk.length)
    merged.set(this.#buf)
    merged.set(chunk, this.#buf.length)
    this.#buf = merged

    const out: Uint8Array[] = []
    for (;;) {
      // Drop leading junk until we see a known H:4 type (or the buffer ends).
      while (this.#buf.length > 0 && headerLen(this.#buf[0]!) < 0) {
        this.#buf = this.#buf.subarray(1)
      }
      const packet = this.#tryTake()
      if (!packet) break
      out.push(packet)
    }
    return out
  }

  reset() {
    this.#buf = new Uint8Array(0)
  }

  #tryTake(): Uint8Array | null {
    if (this.#buf.length < 1) return null
    const type = this.#buf[0]!
    const need = headerLen(type)
    if (need < 0) return null
    if (this.#buf.length < 1 + need) return null
    const payloadLen = payloadLength(type, this.#buf.subarray(1, 1 + need))
    if (payloadLen < 0) {
      this.#buf = this.#buf.subarray(1)
      return null
    }
    const total = 1 + need + payloadLen
    if (this.#buf.length < total) return null
    const packet = this.#buf.subarray(0, total)
    this.#buf = this.#buf.subarray(total)
    return packet
  }
}

function headerLen(type: number): number {
  switch (type) {
    case H4_CMD:
      return 3
    case H4_ACL:
    case H4_ISO:
      return 4
    case H4_SCO:
      return 3
    case H4_EVT:
      return 2
    default:
      return -1
  }
}

function payloadLength(type: number, hdr: Uint8Array): number {
  switch (type) {
    case H4_CMD:
      return hdr[2]!
    case H4_ACL:
    case H4_ISO:
      return hdr[2]! | (hdr[3]! << 8)
    case H4_SCO:
      return hdr[2]!
    case H4_EVT:
      return hdr[1]!
    default:
      return -1
  }
}
