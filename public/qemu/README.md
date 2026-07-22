# qemu-wasm artifacts

This directory holds the emulator and the guest images. It is gitignored — the
GPLv2 emulator and compiled guests are build outputs, not source.

The app ships with a **mock backend** and only switches to the real emulator once
a `.wasm` is present here.

## Just build it

Two scripts reproduce everything. Neither needs a local Emscripten or Zephyr
toolchain — both run in containers.

```console
$ tools/build-qemu-wasm.sh            # emulator (slow: compiles glib etc. to wasm)
$ tools/build-zephyr-image.sh         # Cortex-M3 shell + hello world
$ tools/build-zephyr-image.sh qemu_cortex_a53  # display + hello world
```

Then restart the dev server. The `qemuAssetProbe` plugin in `vite.config.ts`
scans this directory at config time, and Vite's static middleware also caches
what it finds here at startup, so a running server will not pick up new files.

With no argument the emulator script builds both `arm-softmmu` and
`aarch64-softmmu`; a target argument builds only that one. The Zephyr script
defaults to `qemu_cortex_m3`. Both scripts honour their environment overrides;
see the headers.

## What ends up here

```
public/qemu/
  qemu-system-arm.js          ARM factory
  qemu-system-arm.wasm        Cortex-M emulator
  qemu-system-arm.worker.js   pthread worker shim
  qemu-system-aarch64.js      AArch64 factory
  qemu-system-aarch64.wasm    Cortex-A53 emulator
  qemu-system-aarch64.worker.js
  efi-virtio.rom              default virt-machine option ROM
  vgabios-ramfb.bin           ramfb option ROM
  zephyr/
    qemu_cortex_m3/
      shell.elf               guest images, injected into the Emscripten FS
      hello_world.elf
    qemu_cortex_a53/
      display.elf
      hello_world.elf
```

Emscripten names each generated JS loader after its binary. The selected board
loads that matching JS/Wasm pair, and the app's `locateFile` hook prefixes its
sibling assets with `/qemu/`.

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
| ARM `.wasm` size | 55 MB | **34 MB** |
| `Timer with period zero` noise | yes | **none** |
| Zephyr shell + host sensor | works | works |
| `samples/synchronization` | 1 line | 14 lines |

The fork's JIT is not a loss worth mourning: it miscompiles, and disabling it
was what took Synchronization from 1 line to 14 in the first place. See below —
the remaining stall is an upstream TCI bug and affects both.

Separate targets are intentional: upstream's AArch64 TCI build boots the
64-bit `virt` guest but not the Cortex-M3 guest in the browser. The ARM artifact
keeps `lm3s6965evb` working, while the AArch64 artifact supplies the `virt`
machine. Both include the browser-specific sensor, terminal, and ramfb bridges.

Three browser integrations are supplied by
`tools/qemu-patches/`:

* `--js-library=.../xterm-pty/emscripten-pty.js`, or `Module.pty` is ignored and
  the guest's stdio goes nowhere. It has to go in the meson cross file:
  `--extra-ldflags` does not reach the link, and meson snapshots that file at
  configure time, so changing it needs a reconfigure rather than a relink.
* The `qemu-host-sensor` device (see the sensor bridge in the top-level README).
* Stable width, height, stride, format, and pixel-address exports for
  `qemu,ramfb`, allowing JavaScript to render the guest framebuffer.

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
3. **wasm32 normally rejects 64-bit guests.** QEMU's target loop excludes a
   guest wider than the host pointer size. TCI stores guest values independently
   of host pointers, so a small local patch permits this combination when the
   interpreter is explicitly enabled.

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

This limitation applies to the Cortex-M3 board only. Cortex-A53 uses its
architectural timer, and the display sample runs normally.

## Known limits

Verified by testing, not assumed:

- **`lm3s6965evb` works**, interactively, on the ARM binary.
- **`mps2-an385` does not**, on *either* binary, despite booting fine under
  native QEMU with identical argv. It is a genuine mps2/qemu-wasm
  incompatibility, not a build artifact.
- **`qemu_cortex_a53` works** with TCI, including its serial console,
  architectural timer, fw_cfg, and `qemu,ramfb` display.

## Display output

The display path intentionally does not depend on SDL, GTK, VNC, or a QEMU UI
backend. Zephyr's `qemu,ramfb` driver allocates an ARGB8888 framebuffer and
publishes its configuration through fw_cfg. The local QEMU patch exposes the
mapped pixel address and metadata to JavaScript; `hostDisplay.ts` reads the
shared Emscripten heap and `DisplayPanel.tsx` paints it into a canvas.

The stock `samples/drivers/display` sample on `qemu_cortex_a53` is the default
and produces a 1024×768 four-corner test pattern. The panel appears only after
the guest configures ramfb, and can be collapsed or dismissed independently of
the terminal and sensor panel.

This is output-only for now. No virtio input device is connected to browser
pointer events, and keyboard input remains attached to the serial terminal.
