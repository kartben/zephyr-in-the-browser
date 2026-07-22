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

`tools/build-qemu-wasm.sh` uses two pinned QEMU trees:

- `arm-softmmu` builds **upstream QEMU** (`qemu/qemu` at `v10.1.0`) with TCI.
- `aarch64-softmmu` builds `ktock/qemu-wasm` at the commit named by
  `QEMU_JIT_REF`, using its experimental wasm32 TCG backend. Set
  `QEMU_AARCH64_ACCEL=tci` to build upstream QEMU for this target instead.

Emscripten support landed upstream in QEMU 10.1, contributed by Kohei Tokunaga,
who also maintains the experimental JIT branch.

`configure` auto-detects Emscripten and pulls in `configs/meson/emscripten.txt`,
which already carries ASYNCIFY, PROXY_TO_PTHREAD, EXPORT_ES6 and FORCE_FILESYSTEM.
The upstream TCI build uses two important flags:

```
--with-coroutine=wasm      upstream has a real wasm backend (the fork used 'fiber')
--enable-tcg-interpreter   mandatory: the TCG->Wasm JIT is not upstreamed
```

The JIT does not write executable memory. Translation blocks start in the TCI
interpreter; after 1,500 executions, the backend emits a small WebAssembly
module and asks the browser to compile it. On a local Cortex-A53 guest doing 20
million integer loop iterations, end-to-end time fell from 7.1 seconds on TCI to
1.1 seconds on JIT (about 6.5×). The stock display sample also boots, completes
its timer-driven delay, and renders ramfb correctly.

The scope is deliberately narrow. This JIT family previously miscompiled a hot
Cortex-M translation block, breaking Zephyr's timer/synchronization paths. The
ARM artifact therefore stays on upstream TCI; only the verified Cortex-A53
`virt` machine gets JIT. The wasm32 branch was chosen instead of the newer
wasm64 experiment so the result does not require WebAssembly Memory64.

Separate targets are intentional: the ARM artifact keeps `lm3s6965evb`
working, while the AArch64 artifact supplies the 64-bit `virt` machine. Both
include the browser terminal bridge; ARM adds the host sensor, and AArch64 adds
the ramfb bridge.

Three browser integrations are supplied by the target-specific patch
directories under `tools/`:

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
3. **upstream wasm32 normally rejects 64-bit guests.** QEMU's target loop excludes a
   guest wider than the host pointer size. TCI stores guest values independently
   of host pointers, so a small local patch permits this combination when the
   interpreter is explicitly enabled. The JIT branch already supports the
   AArch64-on-wasm32 combination and does not use that patch.

Two more are baked into `tools/Dockerfile.deps`: zlib now comes from its GitHub
release (zlib.net keeps only the current release at its root path, and `curl`
pipes the resulting HTML error page into `tar`, which fails as "File format not
recognized" rather than as a download error), and `tomli` is installed because
QEMU 10.1's configure requires it.

The Cortex-M stall reproduces identically on the fork with its JIT disabled (14
lines) and on upstream (14 lines), across two independent QEMU versions. That
places the remaining defect in the shared TCI path rather than in any fork. The
known Cortex-M JIT miscompile is avoided by never selecting JIT for that target.

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
- **`qemu_cortex_a53` works** with the wasm32 JIT, including its serial console,
  architectural timer, fw_cfg, and `qemu,ramfb` display. Upstream TCI remains a
  build-time fallback.

## Display output

The display path intentionally does not depend on SDL, GTK, VNC, or a QEMU UI
backend. Zephyr's `qemu,ramfb` driver allocates an ARGB8888 framebuffer and
publishes its configuration through fw_cfg. The local QEMU patch exposes the
mapped pixel address and metadata to JavaScript; `hostDisplay.ts` reads the
shared Emscripten heap and `DisplayPanel.tsx` paints it into a canvas.

The stock `samples/drivers/display` sample on `qemu_cortex_a53` is the default.
A local devicetree overlay reduces its ramfb surface from Zephyr's 1024×768
default to 600×400: that is 69.5% fewer pixels for both the emulated guest and
the browser's BGRA-to-RGBA conversion. In a browser comparison with the same
JIT emulator, the sample reached `Display starts` at 130 ms of guest time,
versus 370 ms for the 1024×768 image (about 2.8× faster). The panel appears only
after the guest configures ramfb, and can be collapsed or dismissed
independently of the terminal and sensor panel.

This is output-only for now. No virtio input device is connected to browser
pointer events, and keyboard input remains attached to the serial terminal.
