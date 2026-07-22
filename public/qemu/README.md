# Drop qemu-wasm artifacts here

This directory is empty on purpose. The app ships with a **mock backend** and
only switches to the real emulator once a qemu-wasm build is present here.

Nothing in this directory is built by this repo. Producing the artifacts needs
Docker, Emscripten and a Zephyr toolchain — a separate, heavy step. Upstream is
[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm).

## Files to drop in

| File | What it is |
| --- | --- |
| `out.js` | The Emscripten-generated JS. Upstream's build emits it as `qemu-system-<arch>`; rename it to `out.js`. |
| `qemu-system-<arch>.wasm` | The QEMU binary. |
| `qemu-system-<arch>.data` | `file_packager` bundle holding `zephyr.elf` and any BIOS blobs. |
| `load.js` | `file_packager`'s loader stub, which fetches and mounts the `.data`. |
| `qemu-system-<arch>.worker.js` | pthread worker shim. Only some Emscripten versions emit it; copy it if it exists. |

Keep the original `qemu-system-<arch>` names for everything except the main JS —
`out.js` refers to its siblings by those names, and the app's `locateFile` hook
just prefixes them with `/qemu/`.

`<arch>` must match the `qemuBinary` field of the board entry in
[`src/boards.ts`](../../src/boards.ts) — `qemu-system-arm` for `qemu_cortex_m3`,
`qemu-system-riscv32` for `qemu_riscv32`.

## Two things that will silently break it

**Build QEMU with xterm-pty's Emscripten library.** The whole terminal seam
depends on it. Upstream's `EXTRA_CFLAGS` already contains it; do not drop it:

```
--js-library=/build/node_modules/xterm-pty/emscripten-pty.js
```

Without it, `Module.pty` is ignored and the guest's stdio goes nowhere.

**Keep these link flags**, which the app's loader depends on:

```
-sEXPORT_ES6=1                                    # out.js default-exports the factory
-sEXPORTED_RUNTIME_METHODS=...,TTY,FS             # the TTY poll patch needs Module.TTY
```

## Building

Follow the "Building" section of the upstream README. Its examples target
`x86_64`, `aarch64` and `riscv64`; for the Zephyr boards in `src/boards.ts`
substitute the target list and keep everything else identical:

```console
# for qemu_cortex_m3
--target-list=arm-softmmu     ... && emmake make -j $(nproc) qemu-system-arm

# for qemu_riscv32
--target-list=riscv32-softmmu ... && emmake make -j $(nproc) qemu-system-riscv32
```

32-bit guests are the best-supported case: TCI (interpreter) support for them was
upstreamed in QEMU 10.1. 64-bit TCI and the Wasm TCG JIT are still in review
upstream, so they need ktock's fork.

## Packaging the Zephyr image

The board argv in `src/boards.ts` expects the guest at `/pack/zephyr.elf`, so the
`.data` bundle must mount at `/pack/`.

```console
$ west build -b qemu_cortex_m3 zephyr/samples/subsys/shell/shell_module
$ mkdir -p /tmp/pack && cp build/zephyr/zephyr.elf /tmp/pack/
$ /emsdk/upstream/emscripten/tools/file_packager.py qemu-system-arm.data \
    --preload /tmp/pack@/pack > load.js
```

Boards that need firmware blobs (RISC-V `virt` with OpenSBI, for example) should
get them into `/tmp/pack/` too — that is what the `-L /pack/` argument points at.
`qemu_riscv32` as configured passes `-bios none`, so Zephyr boots directly.

## After dropping the files in

Restart the dev server. The Vite plugin `qemuAssetProbe` scans this directory at
config time, so a running server will not notice new files. On the next start the
app defaults to the `qemu-wasm` backend automatically.

Expect it to be slow. Even with the JIT, a browser-hosted QEMU is far from native.
