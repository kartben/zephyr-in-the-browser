# qemu-wasm artifacts

This directory holds the emulator and the guest images. It is gitignored — a
~34 MB GPLv2 emulator and compiled guests are build outputs, not source.

The app ships with a **mock backend** and only switches to the real emulator once
a `.wasm` is present here.

## Just build it

Two scripts reproduce everything. Neither needs a local Emscripten or Zephyr
toolchain — both run in containers.

```console
$ tools/build-qemu-wasm.sh            # emulator (slow: compiles glib etc. to wasm)
$ tools/build-zephyr-image.sh         # guest image
```

Then restart the dev server. The `qemuAssetProbe` plugin in `vite.config.ts`
scans this directory at config time, and Vite's static middleware also caches
what it finds here at startup, so a running server will not pick up new files.

Defaults are `arm-softmmu` and `qemu_cortex_m3` running
`samples/subsys/shell/shell_module`; both scripts take arguments and honour
`ZEPHYR_WS`, `QEMU_WASM_REF` and friends. See the headers.

## What ends up here

```
public/qemu/
  out.js                      Emscripten JS (default-exports the factory)
  qemu-system-arm.wasm        the emulator
  qemu-system-arm.worker.js   pthread worker shim
  zephyr/
    qemu_cortex_m3/
      shell.elf               guest images, injected into the Emscripten FS
      hello_world.elf
```

Emscripten names its generated JS after the binary; the loader expects `out.js`,
which is why the build script renames it. Everything else keeps its original
name — `out.js` refers to its siblings by those names and the app's `locateFile`
hook just prefixes them with `/qemu/`.

Note there is **no `load.js` and no `.data`**. A Zephyr image is ~64 KB, so
rather than repackaging a multi-megabyte file_packager bundle to carry it, the
backend fetches it over HTTP and writes it into the Emscripten filesystem in
`preRun` via the exported `FS_createPath` / `FS_createDataFile` helpers. Boards
that genuinely need a bundle (firmware blobs, a root filesystem) can still set
`usesDataBundle: true` in `src/boards.ts`, and the loader will pull `load.js`.

## Where the emulator comes from

`tools/build-qemu-wasm.sh` builds **upstream QEMU** (`qemu/qemu`, pinned to
`v10.1.0` via `QEMU_REF`). Emscripten support landed in 10.1, contributed by
Kohei Tokunaga — the same author as the ktock/qemu-wasm fork this project used
to build against — so the fork is no longer needed.

`configure` auto-detects Emscripten and pulls in `configs/meson/emscripten.txt`,
which already carries ASYNCIFY, PROXY_TO_PTHREAD, EXPORT_ES6 and FORCE_FILESYSTEM.
Two flags are not optional:

```
--with-coroutine=wasm      upstream has a real wasm backend (the fork used 'fiber')
--enable-tcg-interpreter   mandatory: the TCG->Wasm JIT is not upstreamed
```

Being TCI-only is the trade. Measured on the same Zephyr image:

| | ktock 8.2.0 fork | upstream v10.1.0 |
| --- | --- | --- |
| `.wasm` size | 55 MB | **34 MB** |
| `Timer with period zero` noise | yes | **none** |
| Zephyr shell + host sensor | works | works |
| `samples/synchronization` | 1 line | 14 lines |

The fork's JIT is not a loss worth mourning: it miscompiles, and disabling it
was what took Synchronization from 1 line to 14 in the first place. See below —
the remaining stall is an upstream TCI bug and affects both.

Two things upstream deliberately leaves out, both supplied by
`tools/qemu-patches/`:

* `--js-library=.../xterm-pty/emscripten-pty.js`, or `Module.pty` is ignored and
  the guest's stdio goes nowhere. It has to go in the meson cross file:
  `--extra-ldflags` does not reach the link, and meson snapshots that file at
  configure time, so changing it needs a reconfigure rather than a relink.
* The `qemu-host-sensor` device (see the sensor bridge in the top-level README).

The dependency image — glib, pixman, zlib and libffi cross-compiled to Wasm — is
built from `tools/Dockerfile.deps`, vendored from ktock's so this repository does
not depend on that fork at all.

## Build workarounds still needed

`tools/build-qemu-wasm.sh` handles these; listed so the workarounds are
reviewable rather than mysterious.

1. **meson subprojects cannot be fetched in-container.** The QEMU source is
   mounted read-only, so meson cannot `git init` into `subprojects/`. They are
   pre-fetched on the host. This bites `arm-softmmu` harder than most targets:
   ARM machines require libfdt, so a missing `dtc` is a hard error rather than a
   skipped optional feature.
2. **`berkeley-*` subprojects have no `meson.build`.** Wraps declaring
   `patch_directory` get theirs from `subprojects/packagefiles/`, an overlay
   meson applies only when it downloads the wrap itself. Pre-fetching by hand
   skips it, so the script applies the overlay explicitly.

Two more are baked into `tools/Dockerfile.deps`: zlib now comes from its GitHub
release (zlib.net keeps only the current release at its root path, and `curl`
pipes the resulting HTML error page into `tar`, which fails as "File format not
recognized" rather than as a download error), and `tomli` is installed because
QEMU 10.1's configure requires it.

The stall reproduces identically on the fork with its JIT disabled (14 lines) and
on upstream (14 lines), across two independent QEMU versions. That places the
remaining defect in the shared TCI path rather than in any fork, and makes it
filable directly against QEMU. Two separate bugs, in other words — the JIT one
is gone now that the JIT is, and this one is not.

**Zephyr's own QEMU patches do not help either** — worth stating, since the SDK
maintaining a fork makes it a natural thing to reach for. `sdk-ng` builds
`zephyrproject-rtos/qemu`, which is v10.0.2 plus 20 commits: five xtensa, two RX,
a Renesas CMT timer, a MIPS bootloader tweak, an APIC fallthrough, and build
plumbing. None touch ARM, Cortex-M, SysTick or stellaris. Consistent with stock
Ubuntu 8.2.2, carrying no Zephyr patches, running the sample correctly.

## Known limits

Verified by testing, not assumed:

- **`lm3s6965evb` works**, interactively, on the purpose-built binary.
- **`mps2-an385` does not**, on *either* binary, despite booting fine under
  native QEMU with identical argv. It is a genuine mps2/qemu-wasm
  incompatibility, not a build artifact.
- **A 64-bit Cortex-A53 guest does not** on the prebuilt aarch64 binary, secure
  or non-secure. Also fine natively. Untested on a purpose-built
  `aarch64-softmmu`, which — given how much the arm rebuild improved things —
  is the obvious next experiment.

## Display output is not possible with these artifacts

Serial only, and not because the app lacks a window for it. Checked, not assumed:

**qemu-wasm has no display backend.** Both published builds come up empty:

| build | `SDL_` refs in `out.js` | `canvas` refs |
| --- | --- | --- |
| aarch64 | 0 | 0 |
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

**The boards that could do it do not run here.** `lm3s6965evb` has no fw_cfg, PCI
or virtio-mmio, so neither ramfb nor virtio input exists on it.

Virtio *input* is real in Zephyr (`drivers/input/input_virtio.c`,
`CONFIG_INPUT_VIRTIO`, wired on `qemu_cortex_a53` via
`-device virtio-tablet-device`), but it needs the `virt` machine and is not much
use without a display.

Getting a framebuffer into the browser therefore needs, in order:

1. A qemu-wasm build with a canvas display path — Emscripten's SDL2 port
   (`-sUSE_SDL=2`) driving `ui/sdl2.c`. Unproven: canvas calls have to be proxied
   to the main thread under `-sPROXY_TO_PTHREAD`, and no upstream demo does it.
2. A guest on the `virt` (or x86) machine that actually executes on that build.
3. Zephyr built with `CONFIG_QEMU_RAMFB_DISPLAY` for that board.

Only then is a display panel in the UI worth building.
