# Live CTF tracer: feasibility study

The question: can this tab show the same kind of live Gantt view that
Zephyr's [`trace_viewer.py`](https://docs.zephyrproject.org/latest/samples/subsys/tracing/basic/README.html#viewing-a-ctf-trace-in-the-terminal)
draws in a terminal — thread lanes coloured by run/ready/blocked/sleep,
a clear time axis from t0, follow-the-live-edge — while
`samples/subsys/tracing/basic` runs in the emulator?

**Verdict: yes.** The hard part is not the GUI; it is getting the CTF byte
stream out of the guest. Zephyr already emits CTF. QEMU's wasm build already
exports `FS`. The sample's default backend is already semihosting. The page
can poll `./tracing.bin` and render it.

## What the Zephyr viewer actually is

`scripts/tracing/trace_viewer.py` is ~1,500 lines of dependency-free Python
that:

1. Decodes the packed little-endian CTF records Zephyr's tracing subsystem
   writes (header = `uint64` timestamp + `uint16` id, then fixed-size fields
   from `subsys/tracing/ctf/tsdl/metadata`).
2. Reconstructs a per-thread state machine (run / ready / blocked / sleep /
   suspended) from scheduling events.
3. Draws a Gantt timeline (curses) with one lane per thread, an ISR overlay,
   a time-axis ruler, zoom/pan, live `--follow`, and a metrics strip.

Nothing about that needs a host OS beyond "bytes arrive and a canvas can
paint." A TypeScript port of (1)+(2) plus a canvas panel for (3) is the whole
UI.

## Transport: semihosting first, UART as fallback

### Why semihosting wins today

The sample's baseline `prj.conf` already sets:

```
CONFIG_TRACING=y
CONFIG_TRACING_CTF=y
CONFIG_TRACING_BACKEND_SEMIHOST=y
CONFIG_SEMIHOST=y
CONFIG_TRACING_SYNC=y
```

The backend opens `./tracing.bin` via ARM semihosting and appends every
encoded event. Under native QEMU that file lands in the build directory; the
docs pair it with `trace_viewer.py -f`. Under qemu-wasm, the same semihost
`open`/`write` calls hit Emscripten's MEMFS — and this build already links
with `-sEXPORTED_RUNTIME_METHODS=…,FS` and `-sFORCE_FILESYSTEM`
(`configs/meson/emscripten.txt` in QEMU 10.1). So the page can:

1. Pass `-semihosting` on the QEMU argv (harmless when unused).
2. Poll `Module.FS` for `/tracing.bin` (or `./tracing.bin` relative to cwd).
3. Feed new bytes into the same incremental decoder the Python viewer uses.

**No QEMU C patch. No spare UART. No Zephyr driver of ours.** Bundle the
stock sample, add the flag, read the file.

### The one risk worth naming

qemu-wasm is a `PROXY_TO_PTHREAD` build: QEMU's "main" runs on a worker.
Semihost writes therefore happen on that worker while the page polls from the
UI thread. Emscripten's FS lives in the shared wasm heap, so a growing append
*should* be visible — the kernel ELF is already injected from the UI thread
and read by the worker — but live cross-thread FS polling is less battle-tested
here than the SharedArrayBuffer rings every other bridge uses. If a smoke test
shows the file never growing (or tearing), fall back to the UART path below;
the decoder and panel do not care which transport fed them.

### Fallback: UART CTF on a browser chardev

`prj_uart_ctf.conf` + `zephyr,tracing-uart` on a dedicated PL011. UART1 is
already claimed by GNSS on both boards, so this needs a new `uart2` (or a
generalised TX-capturing chardev on a spare slot) and a small QEMU patch in
the GNSS shape — guest TX bytes into a ring the page drains. That is one
emulator rebuild, after which the transport is as solid as GNSS/netdev. Keep
it in reserve; do not pay the rebuild until semihosting is shown wanting.

RAM-backend + debugger dump is what GDB integration would unlock, and is the
wrong shape for *live* follow. Do not pursue it for this panel.

## What to build (and what this PR ships)

| Piece | Cost | Status |
| --- | --- | --- |
| Bundle `samples/subsys/tracing/basic` on Cortex-A53 | manifest + `boards.ts` line | **shipped** |
| `-semihosting` on the A53 argv | one string | **shipped** |
| CTF decoder + state machine (Python → TS) | ~port of the viewer's non-UI half | **shipped** |
| Ship Zephyr's TSDL `metadata` as a static asset | 30 KB copy | **shipped** |
| `hostTrace.ts` polling `Module.FS` | GNSS-sized bridge | **shipped** |
| Stage `TracePanel` Gantt (lanes, colours, follow, time axis) | new stage overlay | **shipped** |
| Smoke-test under a real qemu-wasm build | needs the image CI / local build | **follow-up** |
| UART chardev fallback | QEMU patch + rebuild | only if semihost fails |

Cortex-M3 is deliberately skipped. The sample is multi-threaded with sleeps;
that board's TCI path already stalls similar workloads (philosophers). The A53
JIT is the right host for a live schedule view.

## GUI parity with `trace_viewer.py`

Aimed-for, not pixel-identical:

- One lane per thread, plus an ISR lane when ISRs appear
- State colours matching the viewer's legend: run (green), ready (yellow),
  blocked (red), sleep (cyan), suspended (muted)
- Time-axis ruler labelled from t0 of the trace (not "0" at the left edge)
- Default live-follow window of **1 s** for the tracing sample (zoom/pan still
  free); the window *is* the selection — no movable playhead
- Zoom (± / wheel / pinch) while LIVE only changes the follow window size;
  pan still detaches from follow
- Live follow pinned to the newest events; pan detaches; an action re-syncs
- Info strip reports running thread + selected lane at the window's right edge
- Compact metrics for the visible window (CPU busy, switch rate)

Deferred (easy later, not load-bearing): curses-style keyboard map, raw CTF
log table (`v` in the Python viewer), playback speed controls. The decoder
keeps every event, so a log view is a panel tab away whenever someone wants it.

## Recommended path

1. Land the page-side stack and the A53 sample (this change).
2. Rebuild guest images (`tools/build-zephyr-image.sh qemu_cortex_a53`) so
   `tracing.elf` exists next to the others.
3. Boot the Tracing app, confirm `/tracing.bin` grows under `-semihosting`,
   confirm the Gantt follows.
4. Only if (3) fails on FS visibility, schedule the UART chardev patch for the
   next emulator rebuild — the panel and decoder stay as they are.
