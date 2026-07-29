/**
 * The address expressions a tour step watches.
 *
 * One rule holds the whole language together: **an expression names a place,
 * and the format says how to read what is there.** `led` is where the spec
 * lives, `led+8` is where its `pin` field lives, `*led` is where the pointer
 * stored at `led` points. Formats that name a C type read at that address;
 * `addr` and `code` render the address itself. It is `x/FMT` from gdb with the
 * parts spelled out, and it needs no type information at all — which is what
 * makes it work against a stock Zephyr build with nothing added to it.
 *
 *     led+1p as u8         the pin number, one pointer past the port pointer
 *     **led as string      the controller's name (spec → device → name)
 *     $pc as code          the function the machine is stopped in
 *     $arg2 as dec         a register holding a count, not an address
 *     led as bytes:12      the whole spec as a hexdump
 *
 * `1p` is a pointer width — 4 bytes on Cortex-M3 and RISC-V, 8 on Cortex-A53.
 * A struct's second field does not start at the same offset on a 32- and a
 * 64-bit guest, and the same tour runs on all three boards, so the unit that
 * makes an offset portable has to exist in the language.
 *
 * Pure and DOM-free: the target is an interface, so the evaluator is testable
 * without a debugger and reusable by the demo target the mock backend runs.
 */

/** What the evaluator needs from whatever it is inspecting. */
export interface TourTarget {
  /** 4 on 32-bit guests, 8 on AArch64 — the width `*` loads. */
  pointerBytes: 4 | 8
  /** Address of a symbol, or null when the ELF has never heard of it. */
  symbol(name: string): number | null
  /** Value of a register by lowercase name (`pc`, `sp`, `x0`, `r3`). */
  register(name: string): number | null
  /** Guest memory, or null when the read faulted. */
  read(addr: number, length: number): Promise<Uint8Array | null>
  /** `function+0x1c` for an address, when symbols allow. */
  label(addr: number): string | null
}

export interface EvalResult {
  /** Rendered value, or an error message when `ok` is false. */
  text: string
  /** Secondary line — the address read from, a symbol for a pointer, … */
  detail: string | null
  ok: boolean
  /** The address the expression resolved to, for "show me this in Mem". */
  addr: number | null
}

/* ------------------------------------------------------------------ *
 * Expression → address
 * ------------------------------------------------------------------ */

type Token =
  | { kind: 'num'; value: number; pointerScaled?: boolean }
  | { kind: 'sym' | 'reg' | 'op'; text: string }

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if ('*+-()'.includes(c)) {
      tokens.push({ kind: 'op', text: c })
      i++
      continue
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i))
      if (!m) return null
      tokens.push({ kind: 'reg', text: m[1]!.toLowerCase() })
      i += m[0].length
      continue
    }
    const number = /^(0[xX][0-9a-fA-F]+|\d+)(p)?(?![A-Za-z0-9_])/.exec(src.slice(i))
    if (number) {
      tokens.push({
        kind: 'num',
        value: Number(number[1]),
        pointerScaled: number[2] !== undefined,
      })
      i += number[0].length
      continue
    }
    const sym = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))
    if (sym) {
      tokens.push({ kind: 'sym', text: sym[0] })
      i += sym[0].length
      continue
    }
    return null
  }
  return tokens
}

class Evaluator {
  private at = 0

  constructor(
    private readonly tokens: Token[],
    private readonly target: TourTarget,
  ) {}

  async run(): Promise<number> {
    const value = await this.sum()
    if (this.at !== this.tokens.length) throw new Error('trailing input')
    return value
  }

  private peek(): Token | undefined {
    return this.tokens[this.at]
  }

  private async sum(): Promise<number> {
    let value = await this.unary()
    for (;;) {
      const token = this.peek()
      if (token?.kind !== 'op' || (token.text !== '+' && token.text !== '-')) return value
      this.at++
      const rhs = await this.unary()
      value = token.text === '+' ? value + rhs : value - rhs
    }
  }

  private async unary(): Promise<number> {
    const token = this.peek()
    if (token?.kind === 'op' && token.text === '*') {
      this.at++
      const addr = await this.unary()
      return this.load(addr)
    }
    return this.primary()
  }

  private async primary(): Promise<number> {
    const token = this.peek()
    if (token === undefined) throw new Error('expression ends early')
    this.at++
    if (token.kind === 'num') {
      return token.pointerScaled ? token.value * this.target.pointerBytes : token.value
    }
    if (token.kind === 'reg') {
      const value = this.target.register(token.text)
      if (value === null) throw new Error(`no register $${token.text}`)
      return value
    }
    if (token.kind === 'sym') {
      const addr = this.target.symbol(token.text)
      if (addr === null) throw new Error(`no symbol \`${token.text}\``)
      return addr
    }
    if (token.text === '(') {
      const value = await this.sum()
      const close = this.peek()
      if (close?.kind !== 'op' || close.text !== ')') throw new Error('missing `)`')
      this.at++
      return value
    }
    throw new Error(`unexpected \`${token.text}\``)
  }

  private async load(addr: number): Promise<number> {
    const width = this.target.pointerBytes
    const bytes = await this.target.read(addr, width)
    if (!bytes || bytes.length < width) throw new Error(`cannot read ${hex(addr)}`)
    return Number(leToBigInt(bytes, width))
  }
}

/** Resolve an expression to the address (or value) it names. */
export async function evalAddress(expr: string, target: TourTarget): Promise<number> {
  const tokens = tokenize(expr)
  if (tokens === null || tokens.length === 0) throw new Error('not an expression')
  return new Evaluator(tokens, target).run()
}

/* ------------------------------------------------------------------ *
 * Formats
 * ------------------------------------------------------------------ */

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16)}`
}

function leToBigInt(bytes: Uint8Array, width: number): bigint {
  let value = 0n
  for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] ?? 0)
  return value
}

const INT_FORMATS: Record<string, { bytes: number; signed: boolean }> = {
  u8: { bytes: 1, signed: false },
  u16: { bytes: 2, signed: false },
  u32: { bytes: 4, signed: false },
  u64: { bytes: 8, signed: false },
  i8: { bytes: 1, signed: true },
  i16: { bytes: 2, signed: true },
  i32: { bytes: 4, signed: true },
  i64: { bytes: 8, signed: true },
}

/** Longest C string a `string` watch will pull out of the guest. */
const MAX_STRING = 96

/** Bytes per read while chasing a NUL. */
const STRING_CHUNK = 16

/**
 * Read a NUL-terminated string a chunk at a time.
 *
 * One big read would be simpler but would fail outright on a string that sits
 * near the end of a mapped region — the stub answers a read that runs off the
 * end with an error, not with the part that was valid. Stopping at the first
 * chunk that faults gives back whatever was readable, which for a string is
 * almost always the whole of it.
 */
async function readCString(addr: number, target: TourTarget): Promise<Uint8Array | null> {
  const out: number[] = []
  for (let at = 0; at < MAX_STRING; ) {
    const chunk = await target.read(addr + at, STRING_CHUNK)
    if (chunk) {
      for (const byte of chunk) {
        // Keep the terminator: it is how the renderer knows the string ended
        // rather than ran out of budget.
        if (byte === 0) return new Uint8Array([...out, 0])
        out.push(byte)
      }
      at += STRING_CHUNK
      continue
    }
    // The chunk crossed the end of what is mapped. Walk the rest a byte at a
    // time: a string that ends just before the boundary is still readable, and
    // it is exactly the interesting case (a name at the end of a .rodata run).
    for (; at < MAX_STRING; at++) {
      const one = await target.read(addr + at, 1)
      if (!one) return out.length > 0 ? new Uint8Array(out) : null
      if (one[0] === 0) return new Uint8Array([...out, 0])
      out.push(one[0]!)
    }
  }
  return out.length > 0 ? new Uint8Array(out) : null
}

function renderInt(bytes: Uint8Array, format: string): EvalResult['text'] {
  const spec = INT_FORMATS[format]!
  let value = leToBigInt(bytes, spec.bytes)
  if (spec.signed) {
    const span = 1n << BigInt(spec.bytes * 8)
    if (value >= span / 2n) value -= span
  }
  const unsigned = spec.signed && value < 0n ? -value : value
  // Small numbers read better in decimal, addresses and masks in hex; showing
  // both costs a column and saves the reader converting in their head.
  return unsigned < 10n ? `${value}` : `${value} · 0x${unsigned.toString(16)}`
}

function renderBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}

function renderCString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  const text = new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end))
  // Control characters mean this was never a string; say so rather than
  // painting escape gibberish into the card.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return '(not a string)'
  return `"${text}"${end < 0 ? '…' : ''}`
}

/**
 * Evaluate one watch row against a target.
 *
 * Errors are values here: a symbol the build optimised away, or a pointer that
 * is still null this early in boot, is information the reader wants on the
 * card — not a reason for the card to be missing.
 */
export async function evalWatch(
  expr: string,
  format: string,
  target: TourTarget,
): Promise<EvalResult> {
  let addr: number
  try {
    addr = await evalAddress(expr, target)
  } catch (err) {
    return { text: err instanceof Error ? err.message : 'bad expression', detail: null, ok: false, addr: null }
  }

  const fail = (why: string): EvalResult => ({ text: why, detail: hex(addr), ok: false, addr })

  if (format === 'addr') {
    return { text: hex(addr), detail: target.label(addr), ok: true, addr }
  }
  if (format === 'code') {
    return { text: target.label(addr) ?? hex(addr), detail: hex(addr), ok: true, addr }
  }
  if (format === 'dec') {
    // The number the expression came to, with nothing read through it. Half of
    // what an ABI passes in a register is not an address at all — a stack size,
    // a pin, a bitmask — and `as u32` on one of those goes looking for memory
    // at 2048 and reports the size of a thread stack as "unreadable".
    return {
      text: addr < 10 ? `${addr}` : `${addr} · ${hex(addr)}`,
      detail: null,
      ok: true,
      addr,
    }
  }
  if (format === 'string') {
    const bytes = await readCString(addr, target)
    if (!bytes) return fail('unreadable')
    return { text: renderCString(bytes), detail: hex(addr), ok: true, addr }
  }
  if (format === 'ptr') {
    const width = target.pointerBytes
    const bytes = await target.read(addr, width)
    if (!bytes || bytes.length < width) return fail('unreadable')
    const value = Number(leToBigInt(bytes, width))
    return { text: hex(value), detail: target.label(value) ?? `at ${hex(addr)}`, ok: true, addr }
  }
  if (format === 'bool') {
    const bytes = await target.read(addr, 1)
    if (!bytes) return fail('unreadable')
    return { text: bytes[0] ? 'true' : 'false', detail: hex(addr), ok: true, addr }
  }
  if (format === 'char') {
    const bytes = await target.read(addr, 1)
    if (!bytes) return fail('unreadable')
    const code = bytes[0]!
    const printable = code >= 0x20 && code < 0x7f ? `'${String.fromCharCode(code)}'` : `\\x${code.toString(16)}`
    return { text: printable, detail: hex(addr), ok: true, addr }
  }
  const bytesFormat = /^bytes:(\d+)$/.exec(format)
  if (bytesFormat) {
    const length = Math.min(Number(bytesFormat[1]), 64)
    const bytes = await target.read(addr, length)
    if (!bytes) return fail('unreadable')
    return { text: renderBytes(bytes), detail: hex(addr), ok: true, addr }
  }
  const spec = INT_FORMATS[format]
  if (spec) {
    const bytes = await target.read(addr, spec.bytes)
    if (!bytes || bytes.length < spec.bytes) return fail('unreadable')
    return { text: renderInt(bytes, format), detail: hex(addr), ok: true, addr }
  }
  return { text: `unknown format \`${format}\``, detail: null, ok: false, addr }
}

/** Every format name the DSL knows, for the docs and for validation. */
export const FORMATS = [
  ...Object.keys(INT_FORMATS),
  'bool',
  'char',
  'string',
  'ptr',
  'addr',
  'code',
  'dec',
  'bytes:N',
]

/** Formats that render the expression itself rather than reading through it. */
const VALUE_FORMATS = ['addr', 'code', 'dec']

/** True for a format the parser will accept — `bytes:N` needs its count. */
export function isKnownFormat(format: string): boolean {
  return (
    format in INT_FORMATS ||
    ['bool', 'char', 'string', 'ptr'].includes(format) ||
    VALUE_FORMATS.includes(format) ||
    /^bytes:\d+$/.test(format)
  )
}
