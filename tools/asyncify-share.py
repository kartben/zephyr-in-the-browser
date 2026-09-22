#!/usr/bin/env python3
"""Report how much of a qemu-wasm binary Binaryen's Asyncify pass instrumented.

    tools/asyncify-share.py public/qemu/qemu-system-arm.wasm [more .wasm ...]

Every function Asyncify instruments begins with a rewind check, a read of the
`__asyncify_state` global, so the share of functions (and of code bytes) whose
first instruction is that `global.get` is the share Asyncify touched. The
global's index comes from the body of the `asyncify_start_unwind` export, which
starts with `i32.const 1; global.set $__asyncify_state`. Optimised links minify
export names, so the export is looked up through the sibling `.js` glue, where
Emscripten binds `_asyncify_start_unwind=wasmExports["xx"]`.

The artifacts carry no name section, so this says how much is instrumented,
not which functions are. See docs/jspi-feasibility.md for what the numbers mean.
"""
import os
import re
import sys


def leb_u(buf, pos):
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def read_name(buf, pos):
    n, pos = leb_u(buf, pos)
    return buf[pos:pos + n].decode('utf-8', 'replace'), pos + n


def start_unwind_export(wasm_path):
    """The (possibly minified) export name of asyncify_start_unwind."""
    glue = os.path.splitext(wasm_path)[0] + '.js'
    try:
        text = open(glue, encoding='utf-8', errors='replace').read()
    except OSError:
        return 'asyncify_start_unwind'
    m = re.search(r'_asyncify_start_unwind=wasmExports\["([^"]+)"\]', text)
    return m.group(1) if m else 'asyncify_start_unwind'


def analyze(path):
    buf = open(path, 'rb').read()
    if buf[:4] != b'\0asm':
        raise SystemExit(f'{path}: not a wasm module')
    pos, sections = 8, {}
    while pos < len(buf):
        sid = buf[pos]
        size, pos = leb_u(buf, pos + 1)
        sections.setdefault(sid, []).append((pos, size))
        pos += size

    n_imported_funcs = 0
    if 2 in sections:
        p, _ = sections[2][0]
        count, p = leb_u(buf, p)
        for _ in range(count):
            _, p = read_name(buf, p)
            _, p = read_name(buf, p)
            kind = buf[p]
            p += 1
            if kind == 0:
                _, p = leb_u(buf, p)
                n_imported_funcs += 1
            elif kind == 1:
                flags = buf[p + 1]
                _, p = leb_u(buf, p + 2)
                if flags & 1:
                    _, p = leb_u(buf, p)
            elif kind == 2:
                flags = buf[p]
                _, p = leb_u(buf, p + 1)
                if flags & 1:
                    _, p = leb_u(buf, p)
            elif kind == 3:
                p += 2
            else:
                raise SystemExit(f'{path}: unknown import kind {kind}')

    exports = {}
    if 7 in sections:
        p, _ = sections[7][0]
        count, p = leb_u(buf, p)
        for _ in range(count):
            name, p = read_name(buf, p)
            kind = buf[p]
            idx, p = leb_u(buf, p + 1)
            exports[name] = (kind, idx)

    p, code_size = sections[10][0]
    count, p = leb_u(buf, p)
    bodies = []  # (size, offset of first instruction)
    for _ in range(count):
        size, p = leb_u(buf, p)
        n_locals, q = leb_u(buf, p)
        for _ in range(n_locals):
            _, q = leb_u(buf, q)
            q += 1
        bodies.append((size, q))
        p += size

    state_global = None
    export = start_unwind_export(path)
    if export in exports and exports[export][0] == 0:
        _, q = bodies[exports[export][1] - n_imported_funcs]
        if buf[q] == 0x23:  # asyncify_get_state: global.get $state
            state_global, _ = leb_u(buf, q + 1)
        elif buf[q:q + 3] == b'\x41\x01\x24':  # i32.const 1; global.set $state
            state_global, _ = leb_u(buf, q + 3)

    def instrumented(body):
        _, q = body
        return state_global is not None and buf[q] == 0x23 and leb_u(buf, q + 1)[0] == state_global

    total_bytes = sum(size for size, _ in bodies)
    hits = [b for b in bodies if instrumented(b)]
    hit_bytes = sum(size for size, _ in hits)
    print(path)
    print(f'  module {len(buf) / 1e6:.2f} MB, code section {code_size / 1e6:.2f} MB, '
          f'{len(bodies)} functions ({n_imported_funcs} imported)')
    if state_global is None:
        print('  no Asyncify instrumentation found (or the start_unwind export was not located)')
        return
    print(f'  instrumented: {len(hits)} functions ({100 * len(hits) / len(bodies):.1f}%), '
          f'{hit_bytes / 1e6:.2f} MB ({100 * hit_bytes / total_bytes:.1f}% of code bytes)')
    print('  largest functions:')
    for body in sorted(bodies, key=lambda b: -b[0])[:8]:
        print(f'    {body[0] / 1e3:7.1f} KB  {"instrumented" if instrumented(body) else "not instrumented"}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for wasm in sys.argv[1:]:
        analyze(wasm)
