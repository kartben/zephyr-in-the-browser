# qemu-wasm artifacts

This directory holds the emulator and the guest images. It is gitignored — a
~55 MB GPLv2 emulator and a compiled guest are build outputs, not source.

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
    qemu_cortex_m3.elf        guest image, injected into the Emscripten FS
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

## Build your own, or borrow upstream's

`tools/build-qemu-wasm.sh` builds `arm-softmmu` from
[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm). Upstream also publishes
prebuilt `aarch64` and `x86_64` artifacts on its demo site, which can be dropped
in here directly:

```console
$ BASE=https://ktock.github.io/qemu-wasm-demo/images/raspi3ap
$ for f in out.js qemu-system-aarch64.wasm qemu-system-aarch64.worker.js; do
    curl -sSf -o "public/qemu/$f" "$BASE/$f"
  done
```

QEMU's `aarch64-softmmu` target includes all the 32-bit ARM machines
(`configs/devices/aarch64-softmmu/default.mak` literally includes
`../arm-softmmu/default.mak`), so that build *can* run a Cortex-M3 guest and is
the fastest way to get started.

**But prefer building your own.** Measured on the same Zephyr image, the
purpose-built `arm-softmmu` binary was strictly better than upstream's prebuilt
`aarch64` one:

| | prebuilt aarch64 | built arm-softmmu |
| --- | --- | --- |
| size | 57.5 MB | 55.0 MB |
| Zephyr `v4.4.0-8956` | boots | boots |
| Zephyr `v4.4.0-8888` | **silent** | boots |
| console errors | `function signature mismatch`, continuously | none |

That middle row is the important one: two Zephyr builds of the *same sample and
same Kconfig*, a few dozen commits apart, both booting fine under native QEMU —
and the prebuilt binary runs one but not the other. Whatever is wrong is
sensitive to the guest instruction stream, not to the machine model. The
`function signature mismatch` errors are its TCG→Wasm JIT failing to compile
blocks and falling back to the interpreter; they vanish entirely on the
purpose-built binary.

Three link flags are load-bearing for this app and must survive any change to
the build:

```
--js-library=.../xterm-pty/emscripten-pty.js   # or Module.pty is ignored and stdio goes nowhere
-sEXPORT_ES6=1                                 # out.js default-exports the factory
-sEXPORTED_RUNTIME_METHODS=...,TTY,FS          # TTY poll patch + the FS_* helpers
```

## Upstream does not build clean

As of 2026-07 the ktock/qemu-wasm README does not work as written.
`tools/build-qemu-wasm.sh` patches all four issues automatically; they are listed
here so the workarounds are reviewable rather than mysterious.

1. **zlib 404.** `zlib.net` keeps only the current release at its root path, so
   the pinned 1.3.1 tarball is gone. `curl -Ls` pipes the HTML error page into
   `tar`, which surfaces as `xz: File format not recognized` rather than a
   download failure. Repointed at the GitHub release.
2. **`dtc` unavailable.** QEMU fetches it as a meson wrap, but the source is
   mounted read-only into the build container, so meson cannot clone into it.
   This bites `arm-softmmu` harder than upstream's tested targets: ARM machines
   require libfdt, so a missing dtc is a hard error rather than a skipped
   optional feature. Pre-fetched on the host.
3. **`keycodemapdb` unavailable.** Same read-only wrap problem.
4. **`berkeley-*` subprojects have no `meson.build`.** Wraps declaring
   `patch_directory` get theirs from `subprojects/packagefiles/`, an overlay
   meson applies only when it downloads the wrap itself. Pre-fetching by hand
   skips it, so the script applies the overlay explicitly.

None require source changes — the toolchain is stale, not broken.

## Sleeping guests hang: a qemu-wasm code-generation bug

Anything that blocks on `k_sleep` or a timeout hangs. `samples/synchronization`
prints one line and stops; `samples/philosophers` paints its first frame and
freezes. Both are fine on real QEMU, so only non-sleeping apps are listed in
`src/boards.ts`.

**The guest is not at fault.** The identical stripped ELF runs correctly under
native QEMU 8.2.2 — the same version ktock's fork is based on — producing 16
alternating lines in 8 seconds, and under 10.0.2 as well.

**`Timer with period zero, disabling` is a red herring.** It prints on every
boot, and it is tempting to blame. Native QEMU 8.2.2 prints it too, on a run that
works perfectly. It is a benign start-up ordering artifact: SysTick's ptimer is
reset before the Stellaris system clock is calculated, so it briefly sees a zero
period, and the clock propagation immediately afterwards repairs it. Traced with
instrumented builds:

```
Timer with period zero, disabling
[systick_set_period] ctrl=00000004 src=cpu cpuclk=0     <- reset, clock not yet set
[ssys_calc] period_ns=80 propagate=1 sysclk=343597383680 <- clock set (80 << 32)
[cpuclk_update] cpuclk=343597383680                      <- propagation repairs it
```

The device emulation is in fact correct. Instrumentation confirmed SysTick ticks
fire, the NVIC pends exception 15, and `CPU_INTERRUPT_HARD` is raised.

**What is actually wrong is the TCG→Wasm JIT.** ktock's backend interprets cold
translation blocks and compiles hot ones to Wasm modules after
`INSTANTIATE_NUM` (1500) executions. Raising that constant out of reach, so
everything stays interpreted, changes the result dramatically and
deterministically:

| build | lines from `samples/synchronization` |
| --- | --- |
| stock (JIT after 1500 executions) | 1 |
| `INSTANTIATE_NUM` raised (interpreter only) | 14 |
| native QEMU 8.2.2 | unbounded |

So the JIT miscompiles something the sample relies on. Fourteen lines is not a
fix though — it still stalls, so there is at least one further defect on the
interpreter path.

Two hypotheses were tested and **ruled out**: the CPU halting in WFI (making WFI
never halt changed nothing), and a QEMU-version regression (8.2.2 native is
fine).

No patch ships for this. Disabling the JIT would slow every guest down and still
does not make the samples work. It wants reporting upstream to ktock/qemu-wasm,
with the reproducer above.

### Upstream QEMU can build for Wasm, and it does not fix this

QEMU has had Emscripten support since **10.1**, contributed by ktock himself, so
the obvious question is whether moving off the fork helps. It was tried, and the
answer is no — though it is attractive for other reasons.

Upstream v10.1.0 builds and boots Zephyr in the browser:

```console
$ ./configure --static --target-list=arm-softmmu --cross-prefix= \
    --without-default-features --enable-system \
    --with-coroutine=wasm --enable-tcg-interpreter
```

`configure` auto-detects Emscripten and pulls in `configs/meson/emscripten.txt`
itself, which already carries the flags this app depends on (ASYNCIFY,
PROXY_TO_PTHREAD, EXPORT_ES6, FORCE_FILESYSTEM). Upstream is **TCI only** — the
TCG→Wasm JIT is still not upstreamed — so `--enable-tcg-interpreter` is
mandatory, and there is a proper `wasm` coroutine backend rather than the fork's
`fiber`.

Measured against the fork:

| | ktock 8.2.0 fork | upstream v10.1.0 |
| --- | --- | --- |
| `.wasm` size | 55 MB | **34 MB** |
| `Timer with period zero` noise | yes | **no** |
| Zephyr shell | boots | boots |
| `samples/synchronization` | 1 line | **14 lines** |

Fourteen is exactly what the fork produces with its JIT disabled. The same
deterministic stall therefore reproduces on **current upstream QEMU**, across two
independent versions, which places the remaining defect in the shared TCI path
rather than in ktock's fork. That makes it filable directly against QEMU.

Two things upstream deliberately leaves out, which any app must add:
`--js-library=.../xterm-pty/emscripten-pty.js` (or `Module.pty` is ignored and
stdio goes nowhere) and the build needs `tomli` in the Python environment. Note
the js-library has to go into the meson cross file — `--extra-ldflags` does not
reach the link — and meson snapshots that file at configure time, so it needs a
reconfigure, not just a relink.

Migrating is still worth considering for the 38% size drop and for dropping the
fork entirely; it just is not a fix for sleeping guests.

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
