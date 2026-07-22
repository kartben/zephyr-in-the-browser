# qemu-wasm artifacts

This directory holds the emulator and the guest images. It is gitignored: the
emulator is a ~57 MB third-party GPLv2 binary and the Zephyr images are build
outputs, so neither belongs in this repo's history.

The app ships with a **mock backend** and only switches to the real emulator once
a `.wasm` is present here.

## What goes here

```
public/qemu/
  out.js                          Emscripten JS (default-exports the factory)
  qemu-system-aarch64.wasm        the emulator
  qemu-system-aarch64.worker.js   pthread worker shim
  zephyr/
    qemu_cortex_m3.elf            guest image, injected into the Emscripten FS
```

`out.js` refers to its siblings by their original names; the app's `locateFile`
hook just prefixes them with `/qemu/`.

Note there is **no `load.js` and no `.data`**. A Zephyr image is ~64 KB, so
rather than repackaging a multi-megabyte file_packager bundle to carry it, the
backend fetches it over HTTP and writes it into the Emscripten filesystem in
`preRun` via the exported `FS_createPath` / `FS_createDataFile` helpers. Boards
that genuinely need a bundle (firmware blobs, a root filesystem) can still set
`usesDataBundle: true` in `src/boards.ts`, and the loader will pull `load.js`.

## Getting the emulator

The current artifacts are upstream's own build, taken from the qemu-wasm demo
site:

```console
$ BASE=https://ktock.github.io/qemu-wasm-demo/images/raspi3ap
$ for f in out.js qemu-system-aarch64.wasm qemu-system-aarch64.worker.js; do
    curl -sSf -o "public/qemu/$f" "$BASE/$f"
  done
```

That is an **aarch64-softmmu** build, which in QEMU is a superset of
arm-softmmu — it carries the 32-bit ARM machines too, which is why a Cortex-M3
guest runs on it and no bespoke `arm-softmmu` build is needed to get started.

To build your own instead, follow the "Building" section of
[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm) and substitute the target
list (`--target-list=arm-softmmu`, then `emmake make qemu-system-arm`). Two flags
in upstream's `EXTRA_CFLAGS` are load-bearing for this app and must be kept:

```
--js-library=/build/node_modules/xterm-pty/emscripten-pty.js   # or Module.pty is ignored
-sEXPORT_ES6=1                                                 # out.js default-exports the factory
-sEXPORTED_RUNTIME_METHODS=...,TTY,FS                          # TTY poll patch + FS_* helpers
```

## Known limits of the stock build

Verified by testing, not assumed:

- **`lm3s6965evb` works.** Zephyr's shell boots and is interactive.
- **`mps2-an385` does not.** It boots fine under native QEMU with identical
  argv, but produces no console output under this Wasm build.
- **A 64-bit Cortex-A53 guest does not**, secure or non-secure. Also fine
  natively.
- The console logs `RuntimeError: function signature mismatch` from the worker
  **even on the working board**. That is upstream's TCG→Wasm JIT failing to
  compile some blocks and falling back to the TCI interpreter; it is noise, not
  the cause of the two failures above.

If you need more machines, build `arm-softmmu` yourself rather than fighting the
prebuilt binary. Expect it to be slow either way — a browser-hosted QEMU running
mostly interpreted is far from native.

## Display output is not possible with these artifacts

Serial only, and not because the app lacks a window for it. Checked, not assumed:

**qemu-wasm has no display backend.** Both published builds come up empty:

| build | `SDL_` refs in `out.js` | `canvas` refs |
| --- | --- | --- |
| aarch64 (used here) | 0 | 0 |
| x86_64 | 0 | 0 |

Strings in the `.wasm` show `-display none` as the only viable type — no `sdl`,
`gtk` or `egl-headless`. `vnc` is present but has no socket path to the browser.
Upstream's tree does carry `ui/sdl2*.c`, but that is stock QEMU source and
`--without-default-features` leaves it out of the build. QEMU has nowhere to put
pixels, so nothing on the JS side can help.

**Zephyr has no virtio-gpu driver**, so `-device virtio-gpu` would have nothing
driving it either. The supported path is `qemu,ramfb`
(`drivers/display/display_qemu_ramfb.c`, `CONFIG_QEMU_RAMFB_DISPLAY`), already in
the devicetrees for `qemu_x86`, `qemu_cortex_a53` and `qemu_riscv64`.

**The boards that could do it do not run here.** `lm3s6965evb` — the one machine
verified working on this Wasm build — has no fw_cfg, PCI or virtio-mmio, so
neither ramfb nor virtio input exists on it. The boards that do carry them are
the 64-bit ones that produce no output under this build.

Virtio *input* is real in Zephyr (`drivers/input/input_virtio.c`,
`CONFIG_INPUT_VIRTIO`, wired on `qemu_cortex_a53` via
`-device virtio-tablet-device`), but it needs the `virt` machine and is not much
use without a display.

Getting a framebuffer into the browser therefore needs, in order:

1. A qemu-wasm build with a canvas display path — Emscripten's SDL2 port
   (`-sUSE_SDL=2`) driving `ui/sdl2.c`. Note this is unproven: canvas calls have
   to be proxied to the main thread under `-sPROXY_TO_PTHREAD`, and no upstream
   demo does it.
2. A 64-bit or x86 guest that actually executes on that build.
3. Zephyr built with `CONFIG_QEMU_RAMFB_DISPLAY` for that board.

Only then is a display panel in the UI worth building.

## Building the guest image

Using the Zephyr container, which needs no local toolchain:

```console
$ docker run --rm -v ~/zephyrproject:/workdir -v "$PWD:/out" -w /workdir \
    ghcr.io/zephyrproject-rtos/zephyr-build:main \
    bash -lc 'echo CONFIG_BOOT_BANNER=y > /tmp/o.conf &&
      west build -p always -b qemu_cortex_m3 \
        zephyr/samples/subsys/shell/shell_module \
        -d /out/build -- -DEXTRA_CONF_FILE=/tmp/o.conf'
```

The stock `shell_module` sample sets `CONFIG_BOOT_BANNER=n`, so the overlay above
turns the banner back on — otherwise the guest boots straight to a prompt with no
sign it is Zephyr. Note that `-DCONFIG_*` on the CMake command line is rejected by
current Zephyr; an overlay file is the supported route.

Strip before serving. The linked ELF is ~1.5 MB, almost all DWARF, against ~64 KB
of loadable image:

```console
$ arm-zephyr-eabi-strip -o public/qemu/zephyr/qemu_cortex_m3.elf build/zephyr/zephyr.elf
```

The argv in `src/boards.ts` mirrors Zephyr's own `boards/qemu/cortex_m3/board.cmake`
and expects the image at `/pack/zephyr.elf`.

## After changing what is here

The `qemuAssetProbe` plugin in `vite.config.ts` scans this directory at config
time, so restart the dev server — a running one will not notice new files.
