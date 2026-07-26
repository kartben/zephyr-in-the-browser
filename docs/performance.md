# Where the performance is

A survey of the levers worth pulling, ordered by expected payoff per hour spent.
Each result says whether it came from the deployed artifact or a local rebuilt
one; unmeasured expectations are labelled as such.

Two things are worth stating before the list, because they decide which half of
the list matters for a given workload:

- **The guest blocks on the page.** Since the generic virtio bridge moved device
  models into TypeScript, a sensor read or an OLED chunk is a guest thread in
  `k_sem_take(…, K_FOREVER)` waiting for the browser's event loop. For anything
  driven over I²C — the OLED, the accel chart, `i2c scan`, every sensor sample —
  *latency*, not emulator throughput, is the limit.
- **Everything else is emulator throughput.** Boot time, LVGL frame rate, the
  philosophers, the shell's responsiveness: these are bounded by how fast the
  wasm build executes guest instructions, which is a build-configuration
  question and barely a JavaScript question at all.

## Summary

| # | Opportunity | Where | Impact | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| 1 | **Atomic QEMU→page request wake** — productionized; no DAC throughput win in A/B test | `src/virtio/transport.ts`, virtio QEMU patch | Medium, latency/idle CPU | Medium | Low |
| 2 | Asyncify probably instruments the TCG hot path | build | High, everything | Medium | Medium |
| 3 | Nothing set an optimisation level at *link* — **patched, unmeasured** | build | Medium–High, everything | Very low | Low |
| 4 | Every ARM machine QEMU ships was compiled in — **patched, unmeasured** | build | High, startup only | Low | Low |
| 5 | emsdk pinned to 3.1.50 (Sept 2023) | `tools/Dockerfile.deps` | Unknown, plausibly high | Medium | Medium |
| 6 | `-icount shift=4` is a guess, never swept | `src/boards.ts` | Medium | Very low | Low (fidelity trade) |
| 7 | QEMU idle drain 10→1 ms + **completion wake** — local measured, release pending | virtio patch | High, I²C-bound | Low | Medium |
| 8 | Seven pollers share the thread that runs xterm and React | `src/host*.ts` | Medium | Medium | Low |
| 9 | Audio is pulled on a 100 ms timer, not an AudioWorklet | `src/hostAudio.ts` | Medium, audio only | Medium | Low |
| 10 | Startup: default board is the interpreter one; no wasm prefetch | `src/boards.ts`, `index.html` | Low–Medium | Low | Low |

## Instruments that already exist

Measure before and after with what is already here rather than building
something new:

- `?profile=1` on the URL, then `window.__zephyrProfile.snapshot()`
  ([`src/display/profile.ts`](../src/display/profile.ts)) — guest paint rate,
  texture uploads, digest and draw cost, **`i2cHz`**, and **`mips`**.
- The Performance panel's MIPS readout
  ([`src/guestStats.ts`](../src/guestStats.ts)) reads QEMU's guest instruction
  counter directly. It is the honest dial for anything in the build section
  below, and it only advances on the A53 board, which is the `-icount` one.
- `node tools/profile-accel.mjs` drives the whole thing under Playwright and
  prints a ten-second sample.

Item 1 added `bridgePollMs` (the compatibility hot-loop pace), `bridgeHz`
(requests drained per second), `bridgeWakeHz` (atomic worker notifications per
second), and `bridgeWaiterActive`. A hot workload on an old emulator gets a
`bridge_waiter_inactive` note; `tools/probe-timer-clamp.mjs` measures the timer
fallback in isolation.

What is still missing is the other half of the round trip: the page cannot see
how long QEMU took to notice a completion. Item 7 is now measured from the
page side via `tools/profile-dac.mjs` (`i2cHz` / `bridgePollMs`); settling the
QEMU-side half still means counting the interval from a completion being
published to the drain timer picking it up.

## 1. The bridge's hot poll runs at 4 ms, not the 1 ms it documents

[`src/virtio/transport.ts:483`](../src/virtio/transport.ts) paces the hot poll
with `schedule(HOT_PERIOD_MS)`, which lands on `setTimeout(poll, 1)` at line 499
— scheduled from inside `poll`, which was itself invoked from a timer callback. That is the textbook shape for the HTML spec's
timer nesting clamp: once the nesting level passes 5, every browser raises the
minimum to 4 ms. The loop reaches nesting level 5 after five iterations — about
5 ms into any burst — and stays there for the rest of the hot window. The
comment at that line, and the "1 ms between polls" in
[`docs/virtio-bridge.md`](virtio-bridge.md#timing), describe an intent the
browser does not honour.

The corroborating measurement is already in the tree:
[`src/virtio/devices/chips/ssd1306.ts:13`](../src/virtio/devices/chips/ssd1306.ts)
records "~100 blocking transfers per second", i.e. **~10 ms per round trip**,
and derives the OLED's ~11 fps from it. A 4 ms page poll plus QEMU's 1 ms busy
drain (item 7) plus main-loop granularity accounts for most of that; a genuine
1 ms poll would not.

Three fixes, in increasing order of both payoff and work:

**(a) Reset the nesting level — a few lines. Done.** The nesting level is
inherited from the task that calls `setTimeout`, and a task started by
`postMessage` sits at level 0, so a `setTimeout(poll, 1)` issued from a
`message` handler is not clamped. The channel was already there for the attach
kick; the hot path now posts to it and arms the timer inside the handler,
keeping the deliberate 1 ms pace — which exists to avoid the ~700k
`Atomics.load`/s busy-loop the file documents — while actually getting 1 ms.

[`tools/probe-timer-clamp.mjs`](../tools/probe-timer-clamp.mjs) measures both
shapes in Chromium and is the evidence for the change:

| Rearmed from | Steady-state period |
| --- | --- |
| the previous timer's callback (before) | 4.14 ms |
| a `MessagePort` message handler (after) | 1.13 ms |

So ~3 ms comes off every blocking transfer. Against the ~10 ms round trip the
OLED measured, that is arithmetic worth about 11 → 16 fps — which
`bridgePollMs`, `bridgeHz` and `i2cHz` in
[`src/display/profile.ts`](../src/display/profile.ts) now report directly, so
the next person does not have to take the arithmetic on trust. `transport.ts`
counts the gaps between consecutive hot polls for exactly that reason: the pace
was wrong for a long time precisely because nothing looked at it.

**(b)+(c) Use an atomic request wake — productionized, with an important
limit.** The earlier gated I²C-only spike established that a worker blocking in
`Atomics.wait` can detect every QEMU request without a polling timeout. In its
A/B test, however, the DAC stayed at ~800 Hz both with and without the worker.
Request detection was therefore not the DAC's throughput bottleneck once the
tick-rate and vendored-sample fixes were present. The remaining ~1.2 ms/request
is more likely real guest-side cost, such as the I²C driver stack at the
guest's measured ~1.1 MIPS.

The production implementation deliberately keeps the useful, low-cost part of
that experiment without moving device models out of the browser thread. A
dedicated detection-only worker blocks on one process-wide request futex and
posts to the existing dispatcher. QEMU increments that monotonic counter after
the release-store that publishes any bridge's `req_wr`, then calls
`emscripten_futex_wake()`. One word and one waiter cover every bridge instance;
the counter also closes the worker-start race because a request published
before the first wait changes the expected value instead of becoming a lost
edge. Device models that own browser state (`localStorage`, motion events, and
UI subscriptions) remain unchanged on the main thread.

This removes the timer-clamping and hidden-tab latency of request detection and
eliminates the bridge's idle polling floor; it is not expected to make the DAC
faster. A local rebuilt A53 artifact measured ~748 request wakes/s, exactly
tracking bridge requests, with `bridgePollMs = 0` and a ~5.5 s DAC period. That
validates wake coverage, not a throughput gain: the earlier same-build A/B test
is the causal measurement. Older emulator artifacts do not expose the request
word, so the page retains its capability-based 1/50 ms timer fallback.

## 2. Asyncify very likely instruments the TCG execution path

`configs/meson/emscripten.txt` links with `-sASYNCIFY=1`, and QEMU's wasm
coroutine backend (`util/coroutine-wasm.c`, selected here by
`--with-coroutine=wasm`) is built on `emscripten/fiber.h`, which is Asyncify.
So Asyncify is structural — it cannot simply be dropped — but *how much of the
binary it instruments* is a build parameter, and nothing in this project has
ever looked at it.

This matters because Asyncify's cost is paid per call in every instrumented
function: a state check on entry, spilling locals to the unwind stack, and a
rewind path. Its analysis is a whole-program reachability question — any
function that could be on the stack when a suspend happens must be instrumented
— and it resolves indirect calls conservatively. QEMU is built out of indirect
calls: `MemoryRegionOps` handlers, `qdev` methods, TCG helpers, and the TCI
interpreter's dispatch. The plausible outcome is that nearly everything is
instrumented, including `cpu_exec` and the interpreter loop that *is* the
Cortex-M3 board's entire execution model.

The diagnostic is one build away and costs nothing to run: add
`-sASYNCIFY_ADVISE` next to the `-O3` in
`tools/qemu-*patches/*-emscripten-optimise-the-link.patch` and rebuild. It
prints every instrumented function and the call path that forced it. If
`tcg_qemu_tb_exec`, the TCI dispatch loop, or the softmmu load/store helpers
appear, prune them with `-sASYNCIFY_REMOVE=…` (or invert it with
`-sASYNCIFY_ONLY=…` once the real suspend set is known) and re-measure with the
MIPS panel.

Risk is real and worth stating plainly: removing a function that genuinely can
be on the stack across a suspend corrupts the unwind rather than failing
loudly. The safe path is to prune only functions the advise output shows are
reached exclusively from the vCPU execution path, and to boot every sample in
`tools/samples.manifest` afterwards — the network and display samples especially,
since they are the ones that suspend for real.

Expected payoff if the hypothesis holds: Asyncify overhead on hot code is
routinely 1.5–2×, and the TCI board pays it on every interpreted guest
instruction. This is the largest single number on the page, and also the least
certain — which is exactly why the advise run should come first.

## 3. Nothing sets an optimisation level at link time

`configs/meson/emscripten.txt` sets `c_link_args` to `-pthread -sASYNCIFY=1
-sPROXY_TO_PTHREAD=1 …` — no `-O`. QEMU's `meson.build` sets
`optimization=2` in its `default_options`, but meson passes optimisation flags
to the *compiler*, not the linker, and for Emscripten the link step is where
Binaryen runs. With no `-O` on the link line, emcc's link-time optimisation
level is 0, which means:

- **wasm-opt's post-link passes do not run.** Asyncify's instrumentation pass
  still runs, because the feature requires it, but the cleanup that normally
  follows it does not. Emscripten's own Asyncify documentation is explicit that
  building without optimisation instruments far more code than necessary — so
  this compounds item 2 rather than being independent of it.
- **`ASSERTIONS` defaults to on** at `-O0`, adding checks throughout the JS glue
  and the runtime.
- The JS glue is not minified (the deployed `qemu-system-aarch64.js` is 172 KB).

**Patched, and that is as far as this can be taken here** — a build needs
Docker and hours, so the number is still owed.
`0009-emscripten-optimise-the-link.patch` (and `0011-` in the JIT series) adds
`-O3` to `c_link_args`/`cpp_link_args`. `-sASSERTIONS=0` is not in it because
`ASSERTIONS` already defaults to 0 at any `-O` above zero; one flag is easier to
attribute a measurement to than two.

It has to be a patch, and now for a verified reason rather than a remembered
one: `configure` adds its generated `config-meson.cross` as a machine file
*first* and `configs/meson/emscripten.txt` *second*, and meson lets the later
file win — so the cross file overwrites the `c_link_args` that `--extra-ldflags`
lands in (`configure` lines 1880–1881 and 1962–1965). Whence the note in
[`public/qemu/README.md`](../public/qemu/README.md) that `--extra-ldflags` does
not reach the link.

To measure: `EMCC_DEBUG=1` on the final link prints the `wasm-opt` invocation,
which is where the optimisation level shows up, and the Performance panel's MIPS
readout is the before/after. Expect wasm-opt at `-O3` to cost minutes and
several GB on a ~19 MB module; `-O2` is the fallback if it OOMs.

Applying this exposed a latent bug in the build script, now fixed: patches are
applied to the working tree and never committed, so a *reused* source directory
still carried the previous run's series, and the per-patch "is this one already
applied?" check stopped working as soon as two patches touched the same lines —
which the xterm-pty and `-O3` patches both do to `c_link_args`. The series is
now re-applied to a restored tree every run. The cost is that hand-edits to the
checkout no longer survive a run, which is why the `ASYNCIFY_ADVISE` experiment
below says to edit the patch instead.

Debug information is *not* a problem, incidentally: the deployed `.wasm` has
neither a name section nor `.debug_*` sections, because meson's `-g` is
compile-only and emcc strips at link. That one is already fine.

## 4. Every ARM machine QEMU ships is in the download

The deployed artifacts:

| Artifact | Raw | gzip (as GitHub Pages serves it) |
| --- | --- | --- |
| `qemu-system-arm.wasm` | 34.4 MB | — |
| `qemu-system-aarch64.wasm` | 19.1 MB | 4.8 MB |

Reading strings out of the deployed aarch64 binary turns up `npcm7xx_bootrom.bin`,
`npcm8xx_bootrom.bin`, "Tioga Pass Single2", "BMC Storage Module" and
"Mellanox ConnectX-6 DX OCP3.0" — Nuvoton BMC machines, an OCP server board and a
PCIe NIC, none of which this project can reach. The build passes
`--without-default-features`, which turns off *features* (SDL, VNC, curses); it
does not pass `--without-default-devices`, which is what governs machines and
device models. So both binaries carry QEMU's entire ARM machine catalogue, while
this project boots exactly two machines: `lm3s6965evb` and `virt`.

**Patched, unmeasured** — `0010-configs-devices-trim-to-the-machines-we-boot.patch`
(`0012-` in the JIT series) adds `configs/devices/<target>-softmmu/browser.mak`,
selected by `configure --with-devices-<arch>=browser`. Each artifact keeps
exactly one machine: `CONFIG_STELLARIS` for arm, `CONFIG_ARM_VIRT` for aarch64.
Trimming ARM softmmu builds this way routinely halves them or better.

**Not** `--without-default-devices`, which is what this document originally
proposed and would have been a quiet disaster. It switches minikconf from
`--defconfig` to `--allnoconfig` (`meson.build:3478`), which turns *every*
`default y` into `n` — including `CONFIG_VIRTIO_BROWSER` and the `qemu-host-*`
devices this project patches in, plus `CONFIG_VIRTIO_NET` and
`CONFIG_VIRTIO_INPUT`. All of those are `default y depends on VIRTIO` and none
is `select`ed by any machine, because they are named on the QEMU command line
instead. They would have vanished with no error and the bridges would simply not
have been there. Disabling boards by name cannot do that: Kconfig `select` still
pulls in everything the kept machine needs, so what goes is only what nothing
refers to.

Two things worth knowing for anyone editing those files:

- **A symbol may be assigned once.** minikconf raises "contradiction between
  clauses" on a second, conflicting assignment rather than letting the later one
  win, so the aarch64 file cannot `include ../arm-softmmu/browser.mak` and then
  re-enable `ARM_VIRT` the way upstream's aarch64 `default.mak` includes arm's.
  The 32-bit list is repeated instead.
- **Upstream's list is stale.** `default.mak` carries every board as a
  commented-out `=n` line, which makes it look like a complete inventory. It is
  not: diffing it against the `default y` symbols in `hw/arm/Kconfig` turns up
  `ALLWINNER_R40`, `MAX78000FTHR` and `FSL_IMX8MP_EVK`, which are real machines
  absent from the comments. They are disabled explicitly. `ARM_V7M` is left on
  deliberately — it is the CPU core, and hw/arm/Kconfig says it "must be
  included in a TCG build due to translate.c".

This buys nothing in steady state — it is download and browser wasm-compile time,
so it is *startup*, which for a demo people try once from a link is arguably the
most user-visible number there is. It also makes the odd fact that the arm
artifact is 80 % larger than the aarch64 one worth a look while in there; both
are `--target-list` single-target builds, so the gap is a difference between the
two source trees rather than something inherent.

`CONFIG_PCI_DEVICES=n` is left commented in both files with the reasoning
written out. It is very likely safe — the guest is virtio-mmio end to end, and
`virt` only *implies* PCI_DEVICES so the PCIe bridge it `select`s outright
survives — but it has not been tried, and being wrong costs an hours-long
rebuild. It is the first thing to flip once a build has succeeded.

## 5. The Emscripten SDK is pinned to 3.1.50

`tools/Dockerfile.deps:16` pins `EMSDK_VERSION_QEMU=3.1.50` with a
`# TODO: support recent version` next to it — a September 2023 toolchain,
inherited from ktock's Dockerfile. Everything in items 2 and 3 is executed by
that toolchain's LLVM and Binaryen, so their payoff is capped by it. A newer
emsdk is worth trying on its own merits, and worth trying *before* concluding
anything about Asyncify pruning.

One thing not to chase yet: JSPI (`-sJSPI`) removes Asyncify instrumentation
entirely and would be the ideal answer to item 2, but QEMU's coroutine backend
here is `emscripten_fiber_*`, which is Asyncify by construction. Switching would
mean a different coroutine backend upstream, not a link flag. Worth watching, not
worth attempting.

## 6. `-icount shift=4` has never been swept

[`src/boards.ts:436`](../src/boards.ts) starts the A53 with
`-icount shift=4,align=off,sleep=on`: 16 ns of virtual time per guest
instruction, i.e. a guest that believes it is running on a 62.5 MIPS CPU. The
`sleep=on` half is doing real work and should stay — it is what warps the virtual
clock forward when the vCPUs idle, and therefore what keeps `k_msleep` samples
from running at wall-clock speed. But `shift=4` itself appears to be an
inherited default rather than something measured.

The shift decides how much *guest work* fits between two timer ticks. At
shift=4, Zephyr's 100 Hz tick interrupts every 625k instructions; at shift=1 it
would be every 5M. For a throughput-bound guest — LVGL compositing, the accel
chart — that is a straight reduction in interrupt and scheduler overhead per unit
of useful work. The cost is fidelity: the guest's clock diverges further from
wall time, and `blinky` already blinks faster than 1 Hz, as
[`src/boards.ts:110`](../src/boards.ts) notes.

The experiment is a one-character edit and a rerun of `tools/profile-accel.mjs`
at shift 1, 2, 3, 4, 5, reading `mips` and `guestFps`. Cheap enough that not
having the curve is the only real problem here.

## 7. QEMU's idle drain sets the latency of every synchronous request

`virtio-browser.c` drains completions on a `QEMU_CLOCK_REALTIME` timer at
`VIRTIO_BROWSER_DRAIN_BUSY_MS 1` while tokens are parked and
`VIRTIO_BROWSER_DRAIN_IDLE_MS` otherwise. **Measured** on Cortex-A53 `dac`
(`tools/profile-dac.mjs`): with idle at 10 ms the stock sawtooth runs at
**~45 I²C Hz** (page poll already ~1.2 ms; guest MIPS ~0.1 — almost always
blocked). One logical ~4 s period takes ~90 s of wall. The mechanism: a
synchronous `dac_write` drops `outstanding` to zero between transfers, and
`-icount sleep=on` then sleeps the host until the idle drain fires — twice
per loop (sleep wake + completion), which matches the ~22 ms/transfer.

**Patched to idle = 1 ms** in the virtio-browser series. **Also:** the page now
actively wakes QEMU on every completion (`Atomics.notify` on
`qemu_virtio_browser_wake_addr` + `_qemu_virtio_browser_kick()` → futex wake,
`qemu_bh_schedule` of the drain under the BQL, `qemu_notify_event`). Draining
inline from the keepalive export crashes A53 (`gicv3` asserts `bql_locked()`):
under `PROXY_TO_PTHREAD` that export runs on the *browser* thread, not the
QEMU pthread. A local rebuilt artifact measured **~748 I²C Hz**, with about
5.5 s per 4096-code DAC period, versus ~236 Hz / 17.3 s on the deployed page
observed before these changes. `bridgeWakeHz` tracked `bridgeHz`, and
`notifyViaKick` handled essentially every completion. The release artifact
still needs rebuilding and publishing.

Superseded: the ~45 Hz measured here turned out to be dominated by the
guest's own tick-rate rounding, not this drain mechanism — see
`zephyr-module/apps/dac_sawtooth` and the DAC entries in
`tools/samples.manifest`. The ~748 Hz local result versus ~236 Hz on the
deployed page also spans a rebuilt emulator and guest, so it must not be
attributed to the atomic request waiter. The same-build A/B experiment in item
1 is the current word: request atomics changed no DAC throughput.

The reverse path from item 1 is nevertheless event-driven now: QEMU notifies
the request waiter, while completions use the existing kick BH. The remaining
gap above the sample's 4.096 s target is most likely guest-side I²C work, not
the request-detection or completion-wake hop.

## 8. Seven pollers share the thread that runs xterm and React

Attached at once on the A53 board, all on the main thread:

| Poller | Period | File |
| --- | --- | --- |
| virtio bridge | atomic request wake; 50 ms maintenance/fallback | `src/virtio/transport.ts` |
| net | 10 ms hot, 100 ms idle | `src/hostNet.ts:398` |
| GPIO (MMIO boards) | 100 ms | `src/hostGpio.ts:135` |
| audio | 100 ms | `src/hostAudio.ts:67` |
| display metadata | 200 ms | `src/hostDisplay.ts:89` |
| trace | 200 ms | `src/hostTrace.ts:181` |
| guest stats | 500 ms | `src/guestStats.ts:99` |
| GNSS transmit | 1000 ms | `src/hostGnss.ts:35` |

Each remaining poller is individually cheap — most are a single shared-memory load — but they
share the thread with xterm.js, React, and Emscripten's proxied main-thread work,
and `transport.ts` already documents catching the display falling behind because
of main-thread contention. The framebuffer upload was moved off this thread for
exactly that reason. Virtio request detection now blocks in a worker, although
its browser-facing device models still dispatch on this thread.

Two remaining directions are worth doing: fold the slow pollers into one timer
that runs all of them (one wakeup at 100 ms instead of five staggered ones), and
move other shared-heap readers with no DOM dependency into dedicated workers.

## 9. Audio is pulled on a 100 ms timer

`src/hostAudio.ts:67` pulls PCM out of the guest's ring on a 100 ms
`setInterval` and schedules it `LEAD_SECONDS = 0.06` ahead of the AudioContext
clock. A 60 ms lead against a 100 ms poll has no margin: any main-thread stall
longer than 60 ms — a React re-render storm, a large terminal write, a GC — is an
audible gap, and in a hidden tab, where timers clamp to ~1 s, it is silence.

An `AudioWorklet` reading the same ring straight out of the shared heap removes
the timer from the path entirely: the audio thread is real-time, never clamped,
and never waits on the main thread. It is the same argument as item 1(b), applied
to the one bridge where the failure mode is something the user can hear.

## 10. Startup details

- **The default board is the interpreter one.** `DEFAULT_BOARD_ID` is
  `BOARDS[0].id`, the Cortex-M3, which runs pure TCI — while the A53 runs the
  wasm JIT, measured at 6.5× TCI in
  [`public/qemu/README.md`](../public/qemu/README.md). First impressions of the
  emulator's speed are formed on the slower of the two. Whether the default
  should move is a product call, not a performance one, but it should be a
  deliberate call.
- **Nothing warms the wasm.** The emulator is fetched only when the user starts a
  board. A `<link rel="prefetch">` for the default board's `.wasm`, or a
  `fetch()` at idle, would overlap a ~5 MB (gzipped) download with the user
  reading the page.
- **`coi-serviceworker` costs a reload.** On GitHub Pages the cross-origin
  isolation headers come from a service worker that has to register and then
  reload the page. That is one extra full page load on every first visit, before
  anything else on this list gets a chance to matter.

## Suggested order

1. ~~Item 1(a) (`postMessage` nesting reset)~~ — done; 4.14 ms → 1.13 ms.
2. ~~Item 1(b)+(c) (atomic request waiter)~~ — done and locally profiled;
   **needs release artifact publication**.
3. ~~Item 3 (link `-O3`)~~ — patched; **needs one rebuild to confirm**, and it
   is a precondition for trusting item 2. Compare MIPS before and after.
4. ~~Item 4 (trim the machine list)~~ — patched; rides the same rebuild as item
   3 without confounding it, since one moves size and the other speed.
5. Item 2's `ASYNCIFY_ADVISE` run — one flag in the same patch, and it either
   promotes item 2 to the top of the list or removes it from it.
6. Items 8/9 — consolidate the remaining main-thread pollers and move audio to
   an `AudioWorklet`.
