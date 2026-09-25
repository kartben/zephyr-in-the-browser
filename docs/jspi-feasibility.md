# Replacing Asyncify with JSPI

**Status: implemented.** The backend sketched below is `util/coroutine-jspi.c`,
carried by every series as `*-util-add-a-JSPI-coroutine-backend.patch`; the
link patches select `-sJSPI` and Wasm-EH `longjmp`; the JIT series stops its
translated blocks from consulting Asyncify; and the page checks for JSPI
before fetching anything (`src/backends/jspi.ts`). What the shipped build
measures against the Asyncify one is in "What shipped", at the end.

The rest is the assessment that preceded it, written 2026-09-22: what it would
take to build the emulator with JavaScript Promise Integration (JSPI) instead
of Asyncify, and what it would buy. The instrumented share and the Cortex-M3
and A53 ceilings are measured.

## Short answer

Feasible and worth doing, but it is a project rather than a link flag:

- **Asyncify is structural.** QEMU's `--with-coroutine=wasm` backend is
  `emscripten_fiber_*`, and Emscripten implements fibers on Asyncify's
  unwind/rewind exports, which do not exist under `-sJSPI`. A JSPI build needs
  a new coroutine backend (about 150 lines of C and 80 of JS, sketched below).
- **Two toolchain changes ride along.** An emsdk newer than the pinned 3.1.50
  (JSPI's current browser API needs 3.1.61 or later; it stopped being
  experimental in 6.0.8), and `-sSUPPORT_LONGJMP=wasm`, because the JavaScript
  `invoke_*` wrappers that implement `setjmp` today sit under every vCPU frame,
  and JSPI cannot suspend across a JavaScript frame.
- **The browser floor moves** to Chrome/Edge 137, Firefox 153 and Safari 27,
  about 73% of global usage today. Older Safari and iOS keep working only if
  the Asyncify artifacts are kept as a fallback, which doubles the builds.
- **Payoff, measured.** 88 to 92% of the code bytes in every deployed binary
  carry Asyncify instrumentation, the largest functions included, which is
  where the TCI interpreter lives. A Cortex-M3 build linked without it runs
  CPU-bound guest code 1.4 to 1.6× faster, boots 1.3× faster, and its wasm is
  55% of the size (tables below). That is the ceiling for the three TCI
  boards; a JSPI backend gives most of it back. On the Cortex-A53 JIT, whose
  translated blocks were never instrumented, the same build measured 1.2× on
  CPU-bound code, 1.3× on a bare boot, nothing on the shell's boot (which
  waits on the page, not the emulator), and a wasm at 60% of the size.
  Coroutine switches themselves are rare here, so the switch mechanism's speed
  is not where the win is.

## What Asyncify does to this build today

### Instrumented share, measured on the deployed artifacts

`tools/asyncify-share.py` classifies every function in a `.wasm` by whether it
starts with Asyncify's rewind check, a read of the `__asyncify_state` global,
which is what Binaryen's pass adds to every function it instruments. On the
artifacts of 2026-09-22 (emsdk 3.1.50, linked at `-O3`):

| Artifact | Functions | Instrumented | Code bytes instrumented | Largest functions |
| --- | --- | --- | --- | --- |
| `qemu-system-arm.wasm` (TCI) | 10,649 | 80.5% | 91.5% of 6.95 MB | 243 KB no; then 132 KB, 106 KB, 63 KB all yes |
| `qemu-system-riscv32.wasm` (TCI) | 11,563 | 76.3% | 90.4% of 7.48 MB | 340 KB yes; 226 KB no; then all yes |
| `qemu-system-xtensa.wasm` (TCI) | 11,874 | 49.9% | 87.7% of 5.45 MB | 227 KB no; then 64 KB, 43 KB, 35 KB all yes |
| `qemu-system-aarch64.wasm` (JIT) | 20,058 | 77.7% | 91.2% of 13.59 MB | 447 KB yes; 358 KB no; then all yes |

The artifacts carry no name section, so the tool cannot say which function is
which. The one large uninstrumented function per binary is consistent with the
decodetree-generated instruction decoder, which makes no indirect calls; the
large instrumented ones are consistent with the TCI interpreter loop and the
translator. The conclusion does not depend on the names: nine tenths of the
code, by bytes, pays the instrumentation. (The TCI glues minify export names,
so `strings` finds no `asyncify_*` in them; the tool resolves the minified
name through the sibling `.js`.)

Why so much: Asyncify instruments every function that could be on the stack
when an unwind starts, and it resolves indirect calls conservatively. The
unwind sources in this link are `emscripten_fiber_swap` (every coroutine
switch), `fd_sync`, `emscripten_sleep` (JIT tree only), `ffi_call_js` and the
`invoke_*` setjmp wrappers. A coroutine switch is reached through
`aio_bh_call` and glib's `g_main_context_dispatch`, both of which dispatch
through function pointers, so every function-pointer target in QEMU (every
`MemoryRegionOps` handler, every qdev method, every TCG helper) is a possible
unwinder, and everything that calls one is instrumented.

### What the instrumentation costs

Per instrumented function: a state check and rewind dispatch at entry, a state
check after every call that may unwind, and spill/restore code for the locals
live across those calls. Binaryen's own numbers (the Asyncify introduction,
2019): fully instrumented binaries are 1 to 2× larger, the slowdown is roughly
in proportion to the size growth, and the outlier was SQLite at about 5× slower
because its hot function is a large interpreter loop. Emscripten's
documentation calls the overhead "something like 50% or so". QEMU's TCI
interpreter is exactly the SQLite shape: one large function, a switch per
guest operation, a helper call per memory access, many locals live across them.

### Where coroutine switches actually happen

Few places, and none of them hot:

- The QMP dispatcher coroutine, created and entered at startup on every board
  because the page always passes `-mon`, then once per command the page sends
  (a handful per session: `query-status`, `stop`, `cont`, HMP commands).
- The block layer, only where a board has a drive: both ESP32 boards boot from
  `-drive if=mtd` flash and write it through the block layer, and the A53
  `virtio_blk` sample. Those switches run on the vCPU thread under the whole
  `cpu_exec` stack, which is why the vCPU path has to be unwindable there and
  cannot simply be pruned out of the instrumented set.

Each switch unwinds the whole instrumented stack into the fiber's Asyncify
buffer and rewinds the other one, plausibly tens of microseconds (not
measured). At a few switches per second that is nothing. The cost of Asyncify
here is the instrumentation every guest instruction pays, not the switching.

## What JSPI changes

JSPI suspends a WebAssembly stack in the engine. An export wrapped with
`WebAssembly.promising` runs on its own stack; when it calls an import wrapped
with `WebAssembly.Suspending` that returns a promise, the frames between the
two are parked and control returns to the JavaScript caller with a promise.
Nothing in the module is rewritten: no instrumentation, no per-call state check
anywhere. Two rules matter for QEMU:

- Only WebAssembly frames may sit between the suspending import and the
  promising export. A JavaScript frame in between traps (the specification:
  "traps if there are any frames of non-WebAssembly functions"). Frames from
  other module instances are fine, which is what lets a JIT-compiled block sit
  on a suspended stack.
- A suspended stack resumes only through its promise, which means through the
  microtask queue. There is no synchronous "switch to that stack".

### Fibers do not survive

`emscripten_fiber_swap` in Emscripten's `src/lib/libasync.js` is implemented
with `_asyncify_start_unwind`, `Asyncify.doRewind` and a per-fiber Asyncify
data buffer, all of which exist only with `-sASYNCIFY=1`. Under `-sJSPI` the
fiber functions still link but fail on first use. Upstream's
`util/coroutine-wasm.c` is unchanged between v10.1.0 and master, and neither
qemu-devel nor ktock's tree carries a JSPI backend, so this is new work.

### A JSPI coroutine backend

Symmetric coroutines are not a JSPI primitive, but they can be built from
nested promising calls plus a small scheduler in JS:

- `qemu_coroutine_new` allocates the C stack as today (a coroutine still needs
  its own shadow stack in linear memory: JSPI switches the engine stack, not
  `__stack_pointer`) and records the entry function. The 1 MB Asyncify buffer
  per coroutine goes away.
- `qemu_coroutine_switch(from, to, action)` saves the shadow stack pointer into
  `from` and calls one `Suspending` import, `qemu_co_switch(to)`, which returns
  a promise; the current stack parks. The JS scheduler then either starts `to`
  for the first time, `WebAssembly.promising(wasmTable.get(entry))(to)`, or
  resolves the promise `to` is parked on. When `to` later switches away, its
  own suspend hands control back to the scheduler, which resolves `from`'s
  promise. Back in C, `qemu_coroutine_switch` restores the shadow stack pointer
  and returns `from->action`, exactly as the fiber version does.
- The leader (a thread's own stack) needs no special init: under JSPI,
  Emscripten already calls every pthread entry point through a promising
  `dynCall` (`invokeEntryPoint` in `libpthread.js`, present in 4.0.10), so
  `main` on the `PROXY_TO_PTHREAD` thread and each vCPU thread can suspend.
- Per-thread state (`current`, `bql_locked`, RCU) is untouched: the coroutine
  runs on the same worker as its caller, just like a fiber.

One switch costs a JSPI suspend plus a promise resolution, about a microsecond
on V8, against a full unwind and rewind today.

### What else has to change

| Change | Why | Size |
| --- | --- | --- |
| emsdk 3.1.50 to 4.0.x or newer | `-sJSPI` on the current browser API is 3.1.61+; 6.0.8 dropped the experimental warning. A `qemu-wasm-deps:emsdk4010` image already exists on the build box. Known cost of the bump, found by that spike: Emscripten 4.x no longer puts the `HEAP*` views on `Module`, and the page's bridges read guest memory through them, so `EXPORTED_RUNTIME_METHODS` has to list them or the A53 aborts at startup with `'HEAPU8' was not exported`. | In progress (performance.md item 5) |
| `-sSUPPORT_LONGJMP=wasm` at compile and link | `cpu_exec`, `tb_gen_code` and the HMP parser use `sigsetjmp`; their calls go through JS `invoke_*` wrappers today, a JavaScript frame under every vCPU frame. A flash write from an MMIO handler, or the JIT's `emscripten_sleep(0)`, would trap under JSPI. Wasm-EH longjmp keeps the stack pure wasm. | One flag in `configs/meson/emscripten.txt` and the deps CFLAGS; full rebuild |
| `util/coroutine-jspi.c` plus a `--js-library` | The backend above | ~150 C and ~80 JS lines, plus a meson option |
| `JSPI_IMPORTS` | `qemu_co_switch`, `emscripten_sleep` (the JIT's `trysleep`), and either drop or verify `ffi_call_js` (linked through glib, not on any QEMU path this project runs) | Link flags |
| JIT backend | `tcg/wasm32.c` binds `helper.u` to a closure reading `Asyncify.state`, which JSPI's runtime does not define; make it return 1. The hand-rolled unwinding the backend emits after every helper call (`tcg_wasm_out_handle_unwinding`, the `BLOCK_PTR` dispatch at block entry) becomes dead weight and can be removed later for smaller blocks. | Small |
| Browser patches | None use Asyncify APIs; they wake QEMU with futexes and atomics | None |
| Page | Module API unchanged; `features.json` and docs only | None |

## Browser floor

| Browser | JSPI on by default |
| --- | --- |
| Chrome, Edge | 137 (May 2025) |
| Firefox | 153 (2026; 139 had it behind a flag) |
| Safari, iOS Safari | 27 (2026) |
| Samsung Internet | 30 |

caniuse puts that at about 73% of global usage today. The page already requires
cross-origin isolation, `SharedArrayBuffer` and WebAssembly threads, so the
audience is modern browsers to begin with, but Safari 27 is weeks old and
Safari 26 has no JSPI at all. The stack-switching proposal (WasmFX), which
would give real coroutines, has not shipped in any browser.

Two ways to handle it: JSPI only, with an "update your browser" message when
`'Suspending' in WebAssembly` is false; or keep building the Asyncify
artifacts and pick a set at load time, at the cost of two emulator builds and
two release asset sets.

## The ceiling, measured

Cortex-M3 (`lm3s6965evb`, pure TCI), the deployed 2026-09-22 artifact against
the same tree linked with `-sASYNCIFY=0`, both from the emsdk 3.1.50 deps
image, headless Chromium on this laptop, medians. Nine samples per workload
(three pages, three runs each), five pages for the shell prompt, three for the
banner. Run-to-run spread within a side stayed under 4% on every workload
(int: 1740 to 1850 ms against 1120 to 1230 ms), so the ratios are not noise.
The Asyncify side also cross-checks: the emsdk-bump session measured the same
guest on the same deployed artifact from its own worktree with its own harness
and got int 1843, float 3184 and mem 8078 ms, within a few percent of the
figures here, so neither harness is measuring itself.

| Metric | Asyncify (deployed) | No Asyncify | Ratio |
| --- | --- | --- | --- |
| `cpu_bench` int: 8M LCG iterations with dependent loads and stores | 1800 ms | 1140 ms | 1.58× |
| `cpu_bench` float: 400k soft-float iterations | 3140 ms | 2240 ms | 1.40× |
| `cpu_bench` mem: 4000 × memset and memcpy over 8 KB | 7750 ms | 5080 ms | 1.53× |
| shell: runtime initialised to `uart:~$` | 125 ms | 92 ms | 1.36× |
| `cpu_bench`: runtime initialised to the Zephyr banner | 97 ms | 77 ms | 1.26× |
| wasm fetch, compile and instantiate on the main thread (local server) | 59 ms | 52 ms | 1.13× |
| `qemu-system-arm.wasm` | 8.36 MB | 4.56 MB | 0.55× |
| code section | 6.95 MB | 3.15 MB | 0.45× |

What it says:

- The instrumentation costs the TCI interpreter 1.4 to 1.6× on compute. That
  is below the interpreter-outlier reading of Binaryen's numbers and squarely
  in the "roughly proportional to size" regime: instrumented, the code section
  is 2.2× larger.
- Boot gains less (1.26 to 1.36×) because it mixes guest execution with QEMU's
  own initialisation and with page-side waits.
- The wasm halves. On a warm local server that is a few milliseconds of
  compile; on GitHub Pages it is 45% less to download before anything runs.
- This is a ceiling. A JSPI backend gives a little back: its switch cost only at
  switches, which are rare, and whatever Wasm-EH `longjmp` costs at `cpu_exec`
  entry, which is per interrupt, not per instruction. Expect 1.3 to 1.5× in
  practice on the TCI boards.

### Cortex-A53, measured

The same guest built for `qemu_cortex_a53` (hardware FP, so the float loop
becomes FP helper calls, and libc's memcpy becomes SIMD helper calls): the
deployed JIT artifact against the same tree linked without Asyncify plus the
two JIT changes of step 5 below, same 3.1.50 image, monitor and gdb chardevs
off, no other argv change (the `virt` machine has no SD slot, and the traced
boot found no coroutine switch). Milliseconds have the 10 ms tick's
granularity here, so the ratios are taken on the guest's 62.5 MHz cycle
counter; the ms columns are for scale.

| Metric | Asyncify (deployed JIT) | No Asyncify | Ratio |
| --- | --- | --- | --- |
| `cpu_bench` int | 270 ms | 210 ms | 1.23× |
| `cpu_bench` float (FP helpers) | 40 ms | 30 ms | 1.22× |
| `cpu_bench` mem (SIMD memcpy helpers) | 1760 ms | 1410 ms | 1.24× |
| `cpu_bench`: runtime initialised to the banner | 180 ms | 135 ms | 1.33× |
| shell: runtime initialised to `uart:~$` | 485 ms | 493 ms | 0.98× |
| wasm fetch, compile and instantiate on the main thread | 80 ms | 70 ms | 1.14× |
| `qemu-system-aarch64.wasm` | 15.89 MB | 9.50 MB, name section included | 0.60× |
| code section | 13.59 MB | 6.56 MB | 0.48× |

What it says:

- 1.2× on compute, against 1.4 to 1.6× on the TCI Cortex-M3. The JIT's
  translated blocks were never instrumented, so what the A53 pays is confined
  to helpers (every FP and SIMD operation is one), TLB misses and MMIO, and the
  1,500-execution TCI warm-up of every block. The three workloads land within
  2% of each other because all three spend their time in those helpers rather
  than in the translated arithmetic.
- The bare boot gains 1.33×; the shell's boot gains nothing. On the A53 the
  shell sample brings up the virtio bridges and spends its boot waiting on the
  page (performance.md, "the guest blocks on the page"), which no emulator
  speedup touches.
- The wasm loses 40%: 6.4 MB off a 15.9 MB download, on the default board, is
  the largest first-visit number on this page.

Not measured, and still estimates:

| Workload | Expected with JSPI | Reasoning |
| --- | --- | --- |
| RISC-V and ESP32 (TCI) | as the Cortex-M3 | Same interpreter, same instrumented share (90.4% and 87.7% of code bytes) |
| Synchronous virtio round trips (I²C, OLED) on the A53 | about 1.2× less guest time per transfer | Guest MIPS while blocked was the binding term (performance.md, "I²C throughput"), and the measured A53 compute ratio applies |
| Coroutine switch | ~1 µs | Irrelevant at current rates |

## Alternatives considered

- **Prune with `ASYNCIFY_ONLY`** (performance.md item 2). Same toolchain, no
  browser floor, and `ASYNCIFY_ADVISE` says exactly which functions need
  listing. But the vCPU path stays in the list on every board that does block
  I/O from an MMIO handler (both ESP32 boards, the A53 `virtio_blk` sample), so
  those gain nothing, and the list is a whole-program invariant that a QEMU bump
  or a new browser patch can silently break. Reasonable as a stopgap for the
  M3 alone.
- **`ASYNCIFY_IGNORE_INDIRECT`**: not viable. Every switch here passes through
  an indirect call (BH dispatch, GSource dispatch, device handlers).
- **A thread per coroutine on `Atomics.wait`**: no instrumentation and no JSPI
  dependency, but QEMU assumes a coroutine runs on its caller's thread
  (`bql_locked`, `current` and RCU are thread-local), which is why the old
  gthread backend was removed.
- **Wait for WasmFX**: not shipped anywhere.

## Risks

- A JavaScript frame on a suspending stack traps at runtime, not at build time.
  `EM_JS` calls that never suspend inside (the JIT's `instantiate_wasm`,
  `helper.u`) are fine; the audit is for JavaScript that calls back into wasm
  and then suspends. `invoke_*` is the known case; `SUPPORT_LONGJMP=wasm`
  removes it.
- Shadow stack handling is the same trap as with fibers: restore
  `__stack_pointer` before anything allocates on the resumed stack.
- Suspended stacks that are dropped (coroutine pool trimming) rely on engine GC
  to reclaim their memory; a leak shows up as growth, not as an error.
- V8's JSPI stacks were fixed-size and large before growable stacks landed;
  QEMU keeps dozens of pooled coroutines per thread.
- `SUPPORT_LONGJMP=wasm` is still marked experimental in Emscripten's settings.
- JSPI inside Workers with shared memory, on three engines, is exactly this
  page's configuration. Chrome's is well exercised; Firefox's and Safari's less.

## Measuring the ceiling: what the experiment took

The ceiling build is one TCI target linked without Asyncify, run on a workload
that never switches coroutines. Getting to "never" took two more steps than
this document first claimed, both found by making the fiber stub throw a stack
(`AB_TRACE=1` in `tools/ab-boot-bench.mjs`, on a build linked with
`--profiling-funcs` so the wasm frames carry names):

1. In the link patch, `-sASYNCIFY=1` becomes `-sASYNCIFY=0` and
   `-sASYNCIFY_IMPORTS=ffi_call_js` goes. The link succeeds: the fiber init
   functions are plain C in libc, and Emscripten supplies an
   `emscripten_fiber_swap` stub that throws on first use. The JIT tree needs
   step 5 as well.
2. **The QMP dispatcher coroutine is created whether or not a monitor exists.**
   `monitor_init_globals` creates and schedules `qmp_dispatcher_co`
   unconditionally, so an empty `features.json` is not enough; the experiment
   carries a patch that deletes those two lines in `monitor/monitor.c`.
3. **The Cortex-M3 machine takes a coroutine to size an SD card that is not
   there.** `lm3s6965evb` has an SSI SD slot, QEMU gives it the default empty
   `if=sd` drive, and `sd_realize` asks that medium-less BlockBackend for
   `blk_getlength`, which is a coroutine wrapper; `sd_reset` does the same
   through `blk_get_geometry` on every reset. `-nodefaults -serial mon:stdio`
   removes the default drive and re-adds exactly the stdio wiring `-nographic`
   would have chosen, so both sides of the A/B run with it.
4. `features.json` set to `[]` so the page passes no `-mon`, `-gdb` or HCI
   chardev, on both sides.
5. **The JIT tree has two Asyncify hooks of its own.** `tcg/wasm32.c` binds
   each block's `helper.u` import to a closure reading `Asyncify.state`, which
   does not exist without Asyncify; the experiment makes it return 1. And
   `trysleep()` calls `emscripten_sleep(0)` once the cap of 15,000 compiled
   blocks is reached, to let the worker's event loop run the finalizers that
   free old instances; that yield needs Asyncify or JSPI, so the experiment
   drops the call, and a run that reached the cap would fall back to TCI for
   the rest of it. A benchmark run stays far below the cap. Both are
   experiment-only patches in the build box's clone, `0021-` and `0022-` of
   the JIT series.

The workload is `zephyr-module/apps/cpu_bench`, built by hand and dropped over
`hello_world.elf` in a scratch copy of the artifact directory, plus the shell
sample for boot time. `tools/ab-boot-bench.mjs` installs one artifact set into
`public/qemu/`, starts vite, drives headless Chromium and reads the terminal
DOM; it refuses to run if the server on its port is serving a different wasm
than the variant's, which is how the first, contaminated batch was caught.

Both artifact sets come from the same emsdk 3.1.50 deps image. Hold the
toolchain constant when repeating this: the emsdk bump changes the deps image
tag, so pass `QEMU_DEPS_IMAGE=qemu-wasm-deps:latest` for a 3.1.50 build, and
in any case measured the bump as throughput-neutral on this same guest, so
nothing in the ratio below is a toolchain effect. The ratio bounds a different
thing from item 5 in performance.md, what removing the instrumentation gives
against what a newer LLVM gives the same instrumented code, and the two must
not be added.

## What shipped

The build the series now produces, measured with the same harness and guest
against the deployed Asyncify artifact. Two toolchain versions are involved
(the deployed build is emsdk 3.1.50, the JSPI build 4.0.10), and performance.md
item 5 measured that bump as throughput-neutral on this very guest, so the
ratios are the backend's.

### Every artifact, by size

The deployed set against the JSPI set built from the same trees and series
(emsdk 4.0.10 adds 0.2% on its own, per performance.md item 5):

| Artifact | Asyncify (deployed) | JSPI | Ratio |
| --- | --- | --- | --- |
| `qemu-system-arm.wasm` | 8.36 MB | 4.57 MB | 0.55× |
| `qemu-system-aarch64.wasm` | 15.89 MB | 8.88 MB | 0.56× |
| `qemu-system-riscv32.wasm` | 9.05 MB | 5.03 MB | 0.56× |
| `qemu-system-xtensa.wasm` | 7.66 MB | 4.81 MB | 0.63× |

No function in any of the four carries the rewind check any more, and none
imports an `invoke_*` trampoline.

### Cortex-M3 (TCI)

Stock board arguments, monitor and gdb chardevs off on both sides, medians of
nine samples per workload:

| Metric | Asyncify (deployed) | JSPI | Ratio |
| --- | --- | --- | --- |
| `cpu_bench` int | 1850 ms | 1290 ms | 1.43× |
| `cpu_bench` float | 3220 ms | 2570 ms | 1.26× |
| `cpu_bench` mem | 8000 ms | 5740 ms | 1.39× |
| `cpu_bench`: runtime initialised to the banner | 103 ms | 73 ms | 1.41× |
| shell: runtime initialised to `uart:~$` | 136 ms | 89 ms | 1.53× |
| wasm fetch, compile and instantiate on the main thread | 64 ms | 38 ms | 1.68× |
| `qemu-system-arm.wasm` | 8.36 MB | 4.57 MB | 0.55× |

Against the ceiling (1.40 to 1.58× on the same workloads) the shipped build
gives back what was predicted: the switch itself, paid only at switches, and
Wasm-EH `longjmp` at `cpu_exec` entry. Boot gains more than the ceiling build
did because the smaller module also compiles faster. All eleven Cortex-M3
samples boot with the monitor, gdb and HCI chardevs on, the toured ones
included, which is the QMP dispatcher coroutine in use on every boot.

### Cortex-A53 (JIT)

Same conditions, ratios on the 62.5 MHz cycle counter:

| Metric | Asyncify (deployed) | JSPI | Ratio |
| --- | --- | --- | --- |
| `cpu_bench` int | 270 ms | 210 ms | 1.27× |
| `cpu_bench` float (FP helpers) | 40 ms | 30 ms | 1.76× |
| `cpu_bench` mem (SIMD memcpy helpers) | 1760 ms | 1260 ms | 1.39× |
| `cpu_bench`: runtime initialised to the banner | 177 ms | 149 ms | 1.19× |
| shell: runtime initialised to `uart:~$` | 485 ms | 495 ms | 0.98× |
| wasm fetch, compile and instantiate on the main thread | 80 ms | 60 ms | 1.31× |
| `qemu-system-aarch64.wasm` | 15.89 MB | 8.88 MB | 0.56× |

The float loop gains more than the ceiling build showed (1.22×) because the
ceiling build still bound the JIT's `helper.u` import to a JavaScript closure
that every helper call invoked; the shipped backend no longer emits that call
at all, and FP-heavy guest code is one helper call per operation. The shell's
boot stays where it was, waiting on the page's virtio bridges. All 47 samples
boot with the monitor, gdb and HCI chardevs on, and virtio-blk enumerates its
disk through the block layer; two samples fail the harness's banner check
for their own reasons (`philosophers` clears the screen, `lp50xx` floods the
log at boot and the banner is among the lines it drops), and both are running
in the transcript.

### The other two artifacts

Not benchmarked separately (same interpreter and same instrumented share as
the Cortex-M3), but validated the same way, monitor, gdb and HCI chardevs on:
the riscv32 artifact boots 41 of the 43 `qemu_riscv32` samples and 25 of the
26 ESP32-C3 ones, the xtensa artifact all 5 ESP32 samples, and the two CI
smoke cases pass with their bridge checks (`accel_chart` on `qemu_riscv32` at
240 I²C transactions per second, `hello_world` on the ESP32 from emulated
flash). The misses are the same banner artifacts as on the A53 (`philosophers`
and `lp50xx`), and both ESP32 boards booting from `-drive if=mtd` is the block
layer taking coroutines from the vCPU thread, the case the design note about
same-thread resumption was written for.

## Sources

- Binaryen's Asyncify introduction, with the overhead measurements:
  <https://kripken.github.io/blog/wasm/2019/07/16/asyncify.html>
- Emscripten's Asyncify and JSPI documentation:
  <https://emscripten.org/docs/porting/asyncify.html>
- Emscripten's fiber and JSPI implementation, `src/lib/libasync.js` and
  `src/lib/libpthread.js`, and the ChangeLog entries for 3.1.61 and 6.0.8:
  <https://github.com/emscripten-core/emscripten>
- The JSPI specification overview:
  <https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md>
- V8 on JSPI, including the cost of a suspend: <https://v8.dev/blog/jspi> and
  <https://v8.dev/blog/jspi-newapi>
- Browser support: <https://caniuse.com/wf-wasm-jspi>
- QEMU's coroutine backend: `util/coroutine-wasm.c` at v10.1.0 and master, and
  ktock's wasm32 TCG backend, `tcg/wasm32.c` and `tcg/wasm32/tcg-target.c.inc`
  at the pinned JIT commit: <https://github.com/ktock/qemu-wasm>
