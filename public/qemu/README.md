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
$ tools/build-qemu-wasm.sh riscv32-softmmu  # optional third target (TCI)
$ tools/build-zephyr-image.sh         # Cortex-M3 GNSS + shell + hello world
$ tools/build-zephyr-image.sh qemu_cortex_a53  # GNSS + display + hello world
$ tools/build-zephyr-image.sh qemu_riscv32     # RISC-V virt samples
```

Then restart the dev server. The `qemuAssetProbe` plugin in `vite.config.ts`
scans this directory at config time, and Vite's static middleware also caches
what it finds here at startup, so a running server will not pick up new files.

With no argument the emulator script builds both `arm-softmmu` and
`aarch64-softmmu`; pass `riscv32-softmmu` for the RISC-V artifact (kept
opt-in until packaging size is settled — see `docs/riscv32-plan.md`). The
Zephyr script defaults to `qemu_cortex_m3`. Both scripts honour their
environment overrides; see the headers.

## What ends up here

```
public/qemu/
  qemu-system-arm.js          ARM factory
  qemu-system-arm.wasm        Cortex-M emulator
  qemu-system-arm.worker.js   pthread worker shim
  qemu-system-aarch64.js      AArch64 factory
  qemu-system-aarch64.wasm    Cortex-A53 emulator
  qemu-system-aarch64.worker.js
  qemu-system-riscv32.js      RISC-V 32-bit factory (opt-in build)
  qemu-system-riscv32.wasm    qemu_riscv32 emulator (TCI)
  qemu-system-riscv32.worker.js
  efi-virtio.rom              default virt-machine option ROM
  vgabios-ramfb.bin           ramfb option ROM
  zephyr/
    qemu_cortex_m3/
      gnss.elf                stock samples/drivers/gnss
      gnss.dts                its flattened devicetree (build/zephyr/zephyr.dts)
      shell.elf               guest images, injected into the Emscripten FS
      shell.dts
      dhcp.elf                networking samples against the in-page LAN
      http_server.elf
      http_get.elf
      hello_world.elf
      ...
    qemu_cortex_a53/
      gnss.elf
      display.elf
      dhcp.elf
      http_server.elf
      echo_server.elf
      http_get.elf
      zperf.elf
      hello_world.elf
      ...
    qemu_riscv32/
      hello_world.elf
      ...                     # same virtio-backed set as A53, minus tracing
```

Each image may carry a `<app>.dts` sibling — the flattened devicetree its build
used, copied verbatim by `tools/build-zephyr-image.sh`. The app parses it to
ground the peripheral panels (which chips have drivers, which pins are wired)
and to show the tree in the devicetree viewer. It is optional: an image without
one boots identically, with the UI falling back to its static tables.

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

`tools/build-qemu-wasm.sh` uses three pinned patch series on two QEMU trees:

- `arm-softmmu` builds **upstream QEMU** (`qemu/qemu` at `v10.1.0`) with TCI
  and `tools/qemu-patches/` (Stellaris / Cortex-M3).
- `aarch64-softmmu` builds `ktock/qemu-wasm` at the commit named by
  `QEMU_JIT_REF`, using its experimental wasm32 TCG backend and
  `tools/qemu-jit-patches/`. Set `QEMU_AARCH64_ACCEL=tci` to build upstream
  QEMU for this target instead.
- `riscv32-softmmu` builds **upstream QEMU** with TCI and
  `tools/qemu-riscv-patches/` (RISC-V `virt` machine wiring). Opt-in: not part
  of the default `all` target yet.

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
working, the AArch64 artifact supplies the 64-bit `virt` machine, and the
optional RISC-V artifact supplies 32-bit `virt` (Zephyr `qemu_riscv32`). ARM
and AArch64 include the browser terminal, the ramfb exports, the GNSS UART,
and the host-sensor (inert, see below), host-audio, host-mic and browser-netdev
bridges. Cortex-M3 alone
gets the host-GPIO device — the LM3S6965 machine has no virtio-mmio bus to
reach the generic bridge — while AArch64 and RISC-V get the input bridge and
the generic virtio bridge. Guest-icount export remains AArch64-only for now.

### The link line, and why `-O3` is a patch

QEMU compiles at `-O2` — meson's `default_options` in `meson.build` set
`optimization=2` — but meson passes optimisation flags to the *compiler* only,
and for Emscripten the link step is where Binaryen runs. With no `-O` on the
link line, emcc's link-time optimisation level is 0: wasm-opt's post-link passes
are skipped, `ASSERTIONS` defaults on, the JS glue is left unminified, and
Asyncify's instrumentation — which every build here carries, because QEMU's wasm
coroutine backend is `emscripten_fiber_*` — is emitted without the cleanup that
normally follows it. Emscripten's own Asyncify documentation is explicit that
building it unoptimised instruments far more code than necessary.

So the patch series adds `-O3` to `c_link_args`/`cpp_link_args`
(`0009-emscripten-optimise-the-link.patch`, and `0011-` in the JIT series).

It has to be a patch, for the same reason `--js-library` is one: `configure`
adds its generated `config-meson.cross` as a machine file **first** and
`configs/meson/emscripten.txt` **second**, and meson lets the later file win —
so `emscripten.txt` overwrites the `c_link_args` that `--extra-ldflags` lands in.
`--extra-cflags` is unaffected and does reach the compile line; it is only the
link that this applies to.

Two practical notes:

- **wasm-opt at `-O3` on a ~19 MB module is slow and memory hungry** — expect
  minutes and several GB on top of an already long build. Drop the patch to
  `-O2` if it OOMs; most of the benefit is there.
- **Verify rather than assume.** `EMCC_DEBUG=1` on the final link prints the
  `wasm-opt` invocation, which is where the optimisation level actually shows
  up. The guest-side number to compare before and after is the Performance
  panel's MIPS readout.

To experiment with other link flags — `-sASYNCIFY_ADVISE` prints every function
Asyncify instruments and why, which is the next thing worth knowing — edit the
patch, not the checkout under `.qemu-wasm-build/`. The build script restores
tracked files to the pinned revision before applying the series on every run, so
hand-edits to the source tree do not survive.

Thirteen browser integrations are supplied by the target-specific patch
directories under `tools/`:

* `--js-library=.../xterm-pty/emscripten-pty.js`, or `Module.pty` is ignored and
  the guest's stdio goes nowhere. It has to go in the meson cross file:
  `--extra-ldflags` does not reach the link (see above), and meson snapshots
  that file at configure time, so changing it needs a reconfigure rather than a
  relink.
* `-O3` on the same link line, for the reasons in "The link line" above — the
  one patch here that is not an integration at all, just the optimisation level
  the build was silently missing.
* `configs/devices/<target>-softmmu/browser.mak`, picked up by
  `--with-devices-<arch>=browser`, cutting QEMU's ARM machine catalogue down to
  the one machine each artifact boots: `lm3s6965evb` (`CONFIG_STELLARIS`) for
  arm, `virt` (`CONFIG_ARM_VIRT`) for aarch64. Deliberately not
  `--without-default-devices`, which would switch Kconfig to `--allnoconfig` and
  silently drop every `default y` device — including the browser bridges above,
  `virtio-net-device` and `virtio-tablet-device`, none of which any machine
  `select`s because they are named on the command line. See the header of either
  .mak file; `docs/performance.md` has the reasoning and what to trim next.
* The `qemu-host-sensor` device. Retained but **inert**: sensors are now
  simulated I²C chips on the generic virtio bridge, so no devicetree node
  references this device and nothing binds it. It is dropped on the next
  rebuild of the patch series — the audio, mic and GPIO patches carry its lines
  as diff context, so removing it is a rebase rather than a deletion.
* The `qemu-host-gpio` device: input pins driven from JavaScript and output pins
  read back by it, exposed through `qemu_host_gpio_set_inputs` /
  `qemu_host_gpio_get_outputs`. Cortex-M3 only.
* The `qemu-host-audio` device: PCM frames the guest writes through Zephyr's
  I2S API cross a ring in the wasm heap to Web Audio, through
  `qemu_host_audio_get_rate` / `_get_channels` / `_get_buffer_samples` /
  `_get_data` / `_get_write_index` and `qemu_host_audio_set_read_index`.
* The `qemu-host-mic` device: the mirror image — capture from `getUserMedia`
  into a ring the guest drains through Zephyr's DMIC API, through
  `qemu_host_mic_get_rate` / `_get_buffer_samples` / `_get_data` /
  `_get_read_index` and `qemu_host_mic_set_write_index`.
* A **generic virtio bridge** (`hw/virtio/virtio-browser.c`), AArch64 only.
  `qemu_virtio_browser_count` and `qemu_virtio_browser_area` discover any
  number of devices; process-wide completion/request futex exports wake QEMU
  and the page in each direction without polling. It keeps
  only what must run on the QEMU thread under the BQL (popping chains,
  gathering their iovecs, pushing to the used ring, raising the interrupt) and
  forwards each chain to the page over a pair of SPSC rings; the *device model*
  is TypeScript. Device id, queue count, feature bits and config space are qdev
  properties, so one C file serves every virtio device type — today a VIRTIO
  GPIO controller (`src/virtio/devices/gpio.ts`), with real interrupts via
  `VIRTIO_GPIO_F_IRQ` and its event virtqueue. It exists for the same reason
  the input-core frontend does: `hw/virtio/` ships only vhost-user shims, which
  forward virtqueues to a daemon in another process, and this build has no
  second process. Its completion drain runs on `QEMU_CLOCK_REALTIME` rather
  than the virtual clock — this is the first bridge where the guest *blocks* on
  a browser answer, and under `-icount … sleep=on` a virtual-clock timer would
  warp past the browser and inflate guest time. The realtime timer and the
  page's adaptive timer remain fallbacks for old artifacts and missed wakes.
  See `docs/virtio-bridge.md`.
* Stable width, height, stride, format, and pixel-address exports for
  `qemu,ramfb`, allowing JavaScript to render the guest framebuffer.
* A **frontend for QEMU's input core** (`hw/misc/qemu-browser-input.c`),
  AArch64 only. Unlike the others this adds no device: pointer events cross a
  lock-free ring into `qemu_input_queue_abs`/`_btn` from a `QEMU_CLOCK_VIRTUAL`
  timer, and the guest-facing side is a stock `virtio-tablet-device` talking to
  Zephyr's upstream `virtio,input` driver. It exists only because a build
  configured `--without-default-features` has no SDL/GTK/VNC to feed that core.
* A browser-fed character backend on each machine's second PL011 UART. It
  accepts NMEA bytes through a lock-free ring and delivers them to the UART from
  QEMU's own thread.
* A `browser` **netdev backend** (`net/browser.c`): raw Ethernet frames cross
  two lock-free rings in the wasm heap, the stock NIC models
  (`stellaris_enet`, `virtio-net-device`) do the guest-facing work, and page
  JavaScript (`src/net/`) implements the LAN itself — DHCP/DNS/SNTP servers,
  ICMP, a TCP engine, an HTTP-over-fetch proxy and a zperf sink. Frame
  injection happens from a `QEMU_CLOCK_VIRTUAL` timer on QEMU's own thread,
  the same pattern the GNSS bridge established, and both directions respect
  NIC flow control (`qemu_can_send_packet` / queued-packet flushing).
* A `qemu_browser_guest_icount` export (AArch64 only) returning the guest
  instruction count, or `-1` when the build is not running under `-icount`. It
  backs the Performance panel's MIPS readout (`src/guestStats.ts`).

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
- **GNSS works on both boards** with Zephyr's unmodified generic NMEA driver and
  stock driver sample.
- **The emulator links an older `xterm-pty` than the page runs.**
  `tools/Dockerfile.deps` installs `xterm-pty@v0.10.1` to supply
  `emscripten-pty.js` at link time, while `package.json` depends on `^0.12.0`
  for the page side. The two have not diverged in a way that breaks the
  terminal, so the pin is deliberately left alone: bumping it invalidates the
  dependency image and forces a full emulator rebuild, which is exactly the
  cost the split release assets exist to avoid. Worth revisiting the next time
  QEMU is rebuilt for another reason.

## GNSS input

Both boards attach a `gnss-nmea-generic` devicetree child to their second PL011
UART at 9600 baud. The browser sends valid GGA and RMC sentences once per second;
Zephyr receives them through its ordinary interrupt-driven UART and modem
layers. The GNSS panel edits latitude, longitude, altitude, speed, bearing, and
satellite count, and can instead follow the browser's Geolocation API when the
user grants permission.

The UART frontend is only touched on QEMU's runtime thread. JavaScript writes
bytes into a single-producer/single-consumer ring through an exported function,
and a virtual-clock timer drains that ring into the character backend. This
keeps the host bridge independent of the Zephyr sample and avoids a custom guest
driver.

## Display output

The display path intentionally does not depend on SDL, GTK, VNC, or a QEMU UI
backend. Zephyr's `qemu,ramfb` driver allocates an ARGB8888 framebuffer and
publishes its configuration through fw_cfg. The local QEMU patch exposes the
mapped pixel address and metadata to JavaScript; `hostDisplay.ts` reads the
shared Emscripten heap.

Because that heap is a `SharedArrayBuffer` (qemu-wasm is a pthread build), it is
visible from any worker. `DisplayPanel.tsx` therefore prefers to render off the
UI thread entirely: it transfers the canvas to a dedicated worker
(`display/renderWorker.ts`) with `transferControlToOffscreen()` and hands it the
shared buffer. The worker reads the framebuffer directly and uploads it to a
WebGL 2 texture — swapping BGRA to RGBA in a fragment shader, avoiding the
earlier per-pixel JavaScript conversion — so the ~1 MB-per-frame upload never
competes with xterm or React on the main thread. The main thread only forwards
ramfb reconfigurations (a new resolution or pixel address, both rare) as
messages; pixels are never posted. There is a two-step fallback for browsers
without OffscreenCanvas or a worker WebGL 2 context: the same WebGL renderer on
the main thread, then the per-pixel Canvas 2D renderer. All three cap at 30 fps.

The stock `samples/drivers/display` sample on `qemu_cortex_a53` is the default.
The `browser_bridge` shield's overlay reduces its ramfb surface from Zephyr's 1024×768
default to 600×400: that is 69.5% fewer pixels for both the emulated guest and
the browser's texture upload. In a browser comparison with the same JIT
emulator, the sample reached `Display starts` at 130 ms of guest time, versus
370 ms for the 1024×768 image (about 2.8× faster). The panel appears only after
the guest configures ramfb, and can be collapsed or dismissed independently of
the terminal and the other device panels.

This is output-only for now. No virtio input device is connected to browser
pointer events, and keyboard input remains attached to the serial terminal.

## Audio: speaker out over I2S, microphone in over DMIC

Like the display, the audio path depends on no QEMU audio backend — the
`-audiodev` layer is not even compiled in. Two sibling MMIO devices carry the
sound, both patched into both machines:

- **`qemu-host-audio`** (Stellaris 0x40062000, virt 0x090d0000) owns a ring
  of 16-bit interleaved PCM the guest fills; rate (8–48 kHz) and channel
  count (1–2) are guest-programmable, defaulting to 16 kHz mono. The guest
  driver implements Zephyr's **I2S API** (transmit-only), so applications
  written against `i2s_configure()`/`i2s_write()` play through the browser's
  speakers unmodified. `hostAudio.ts` polls the exported ring every 100 ms
  and schedules chunks through the Web Audio API; the autoplay policy gates
  playback behind the panel's enable click, and while muted the bridge still
  drains (and drops) samples so the guest cannot tell the difference.
- **`qemu-host-mic`** (Stellaris 0x40063000, virt 0x090e0000) is the mirror
  image: a fixed 16 kHz mono ring the browser fills from `getUserMedia`
  capture (resampled in `hostMic.ts`) and the guest pops over MMIO. The guest
  driver implements Zephyr's **DMIC API**; reads are paced against real time
  and silence-filled when the host supplies nothing, so capture apps behave
  whether or not the user ever grants microphone permission. The packaged demo
  is Zephyr's own `dmic` shell commands (`CONFIG_AUDIO_DMIC_SHELL`: `read`,
  `vu`, `dump`) on the Cortex-A53 shell sample — `dmic vu dmic0` is a live
  level meter. The stock `samples/drivers/audio/dmic` exercises the same driver
  but crashes on 64-bit targets until a one-character upstream fix lands
  (`uint32_t size` passed to `dmic_read()`'s `size_t *`; verified both ways
  on qemu_cortex_a53).

Both rings use free-running sample counters — one side advances the write
index, the other the read index — giving flow control with nothing but atomic
32-bit accesses and no JavaScript on the guest's MMIO path.

The 16 kHz mono default is a deliberate fit for the TCI-interpreted
Cortex-M3: one second of sound is ~16k MMIO writes. The `hostaudio` shell
command (`beep [freq] [ms]`, `melody`) drives the I2S API with integer-only
sine synthesis and bounds its writes by the ring's free space — no `k_sleep`,
so it sidesteps the TCI stall described above. Not virtio-snd, and
deliberately so: Zephyr has no virtio-snd driver and this build has no
audiodev for QEMU's virtio-sound device to render into — see
`docs/audio-feasibility.md` in the repo root.

## Simulation throughput

The aarch64 JIT build exports one more number: `qemu_browser_guest_icount()`,
the guest's retired-instruction counter. `guestStats.ts` samples it against
`performance.now()` a couple of times a second and the **Simulation** panel
(`PerformancePanel.tsx`) shows the result in MIPS with a short sparkline — a
direct, honest read on how fast the wasm TCG JIT is executing the emulated CPU,
the live counterpart to the "6.5× TCI→JIT" figure above.

MIPS, not a ×realtime clock ratio, on purpose: the counter is driven by
`-icount`, and with `sleep=on` a halted guest *warps* virtual time forward to
the next timer, which would make a wall-vs-virtual ratio spike during idle.
Instruction throughput has no such artifact — it simply drops toward zero when
the guest is asleep and climbs when the JIT is busy. The QEMU-side read is a
lock-free seqlock read (`icount_get_raw()`), returned as a `double` so it
crosses into JavaScript as a plain Number, and it never blocks the emulator.

The counter only advances on a machine started with `-icount`. The production
boards leave it disabled because its per-instruction accounting has a material
throughput cost for the browser's synchronous virtio workloads, so the panel
stays hidden. It remains available for explicitly instrumented development
builds.
