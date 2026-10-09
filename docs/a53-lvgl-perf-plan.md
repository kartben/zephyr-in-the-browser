# Plan: where A53 LVGL time goes

LVGL demos on `qemu_cortex_a53` (`lvgl_music`, `accel_chart`) feel slow.
The open question is whether that is **guest instruction throughput** (wasm
JIT / Asyncify / `-icount`) or the **display path** (ramfb → SharedArrayBuffer →
render worker → canvas).

This plan settles that with the instruments already in the tree, then ranks
follow-up work. It does not replace [`performance.md`](performance.md) — that
document is the broader lever survey. This one is the LVGL-specific decision
tree.

## Working hypothesis (start here)

For ramfb LVGL, **the guest is the bottleneck, not the display driver**.

Evidence already in-tree:

- [`performance.md`](performance.md) draws the split explicitly: I²C/OLED is
  *latency*-bound; LVGL frame rate is *emulator-throughput*-bound.
- The FB upload already runs off the main thread
  ([`src/display/renderWorker.ts`](../src/display/renderWorker.ts)); the
  preferred path has no 30 fps cap and skips unchanged frames via checksum.
- Guest `memcpy` into ramfb was the frame cost once (~92 ms at 600×400 under
  `-Os`); it is now ~2.6 ms under `-O2`
  ([`next-drivers.md`](next-drivers.md) §display). What remains is LVGL's own
  compositing.
- Upstream's SHIFT-mode full-screen chart outpaces this emulated A53 even with
  I²C quiet — that is why `accel_chart` ships a 480×320 fork at 25 Hz
  ([`a53-lvgl-stack.md`](a53-lvgl-stack.md)).
- virtio-gpu is **not** a frame-rate fix: pixel copy still dominates, and there
  is no wasm bridge yet anyway ([`next-drivers.md`](next-drivers.md)).

The plan below is designed to *confirm or kill* that hypothesis in one
afternoon of measurement, then only invest where the numbers point.

## Decision tree

```
                 ┌─ guestFps ≈ uploadFps
                 │  drawMs ≪ frame period
                 │  notes has guest_fps_low
  profile=1 ─────┤         → CPU / guest path (Phase B)
                 │
                 └─ uploadFps ≪ guestFps
                    notes has uploads_behind_guest
                    drawMs or digestMs large
                           → display path (Phase C)
```

`i2c_hot` / `bridge_poll_clamped` on `accel_chart` means the *sensor* side is
also in the budget — treat that as a third axis (Phase D), not as "display".

## Phase A — Baseline (one harness, two apps)

**Goal:** numbers, not impressions. Use the same snapshot shape for both demos.

### How to measure

1. Dev server with a real A53 build (`tools/build-qemu-wasm.sh` +
   `tools/build-zephyr-image.sh` already done, or a deployed Pages build).
2. Open with profiling:
   - Chart: `?board=qemu_cortex_a53&app=accel_chart&backend=qemu&profile=1`
   - Music: `?board=qemu_cortex_a53&app=lvgl_music&backend=qemu&profile=1`
3. After the canvas shows `data-renderer=worker-webgl2`, run
   `window.__zephyrProfile.snapshot()` a few times (or let
   [`tools/profile-accel.mjs`](../tools/profile-accel.mjs) drive a 10 s sample —
   extend or clone it for `lvgl_music`).
4. Also note the Simulation panel **MIPS** pill
   ([`src/guestStats.ts`](../src/guestStats.ts)).

### Record

| Field | Source | What it answers |
| --- | --- | --- |
| `guestFps` | `__zephyrProfile` | How often the guest changes ramfb pixels |
| `uploadFps` | same | How often the worker actually uploads |
| `digestMs` / `drawMs` | same | Host-side cost per frame |
| `mips` | same / panel | Guest instruction throughput |
| `i2cHz`, `bridgePollMs`, `bridgeHz` | same | Only meaningful for `accel_chart` |
| `notes[]` | same | Auto classification (`guest_fps_low`, `uploads_behind_guest`, …) |
| canvas `data-renderer` | DOM | Confirm worker path, not main-thread fallback |

### Verdict rules

| Pattern | Conclusion | Next phase |
| --- | --- | --- |
| `guestFps` low, `uploadFps ≈ guestFps`, `drawMs` tiny, no `uploads_behind_guest` | **Guest-bound** | B |
| `guestFps` healthy, `uploadFps` lags, `uploads_behind_guest` | **Display-bound** | C |
| `accel_chart` only: high `i2cHz`, `bridge_poll_clamped` / large `bridgePollMs` | **Bridge latency** on top of paint | D |
| Music (no I²C) slow *and* chart slow with quiet I²C | Pure throughput | B |
| Chart slow, music fine | Chart workload / I²C, not generic display | B + D |

Expect music and chart to both look guest-bound if the hypothesis holds. Chart
may additionally show `i2c_hot` because the accel sample still polls the
sensor over virtio-i2c.

## Phase B — Guest / emulator throughput

Only after Phase A says guest-bound. Ordered by payoff vs invasiveness; each
step has a before/after dial (`mips` + `guestFps`).

### B1. Confirm the display is out of the way (cheap negative test)

Temporarily hide or detach the Display panel / skip starting the render worker
and re-measure `mips`. If MIPS barely moves, host blit was never the limiter.
(Guest still writes ramfb; only the page stops reading it.)

### B2. `-icount shift` sweep (one-char edits)

A53 boots with `-icount shift=4,align=off,sleep=on`
([`src/boards.ts`](../src/boards.ts)). `shift=4` ⇒ 16 ns virt time / insn and a
Zephyr 100 Hz tick every ~625k instructions. Lower shift = fewer timer IRQs per
unit of LVGL work; higher = more.

Sweep `shift` ∈ {1, 2, 3, 4, 5}, rerun `profile-accel.mjs` (and music), plot
`mips` and `guestFps`. Keep `sleep=on` — that is what keeps idle sleepers from
crawling in wall time. Document the fidelity trade (`blinky` already runs fast).

This is the cheapest real experiment in [`performance.md` §6](performance.md).

### B3. Finish measuring the already-patched build knobs

Link `-O3` and the trimmed machine list are **patched but unmeasured**
([`performance.md`](performance.md) items 3–4). One Docker rebuild of
`qemu-system-aarch64.wasm`, then compare MIPS / `guestFps` on both LVGL apps
against the current artifact. Do not attribute LVGL wins to guest code until
this baseline is honest.

### B4. Asyncify advise (largest uncertain win)

Add `-sASYNCIFY_ADVISE` to the emscripten link patch, rebuild, inspect whether
`tcg_qemu_tb_exec` / softmmu helpers are instrumented. If yes, prune with
`-sASYNCIFY_REMOVE=…` carefully and re-measure. Details and risk notes live in
[`performance.md` §2](performance.md). This is the only item that could
plausibly move LVGL by a large factor without changing the guest.

### B5. Guest-side LVGL cost (only if B2–B4 plateau)

If the emulator is already near its ceiling:

- Keep the smaller `accel-display` geometry; do not chase RGB565 yet (marginal
  after the memcpy fix — see `next-drivers.md`).
- Profile inside Zephyr (`CONFIG_TRACING` / the in-page viewer from
  [`tracing-feasibility.md`](tracing-feasibility.md)) to see `lv_timer_handler`
  vs sensor vs idle.
- For music: check demo mode (auto-play blanking after ~35 s is a *content*
  issue, not FPS — [`peripherals.md`](peripherals.md)).

## Phase C — Display path (only if Phase A says so)

Unexpected for ramfb LVGL, but if `uploads_behind_guest` fires:

1. Confirm renderer is `worker-webgl2`, not main-thread Canvas2D (30 fps cap
   still exists on the fallback in [`DisplayPanel.tsx`](../src/components/DisplayPanel.tsx)).
2. Break down `digestMs` vs `drawMs`. Digest should be near zero once the worker
   is in "hot" mode; a large digest means checksum work on a busy FB.
3. Check main-thread contention (seven pollers + xterm + React —
   [`performance.md` §8](performance.md)). A long main-thread task can delay
   worker message handling even when the worker itself is fine.
4. Do **not** start virtio-gpu for speed. Finish it only for a clean damage
   signal / product completeness.

## Phase D — Sensor / bridge (accel_chart only)

If chart FPS tracks `i2cHz` more than `mips`:

1. Re-check bridge poll pace (`bridgePollMs` should be ~1 after the
   MessagePort nesting fix; ~4 means regression).
2. Compare chart with sensor updates paused / detached chip vs live I²C —
   isolates paint from blocking virtio round trips.
3. Larger bridge work (worker + `Atomics.wait`, QEMU notify) is
   [`performance.md`](performance.md) items 1(b)/(c) — high value for OLED and
   sensors, secondary for pure LVGL music.

## Suggested order of work

1. **Phase A** on `accel_chart` and `lvgl_music` — write the two snapshot rows
   into this doc's "Results" section below.
2. Almost certainly **B2** (icount sweep) and **B3** (measure the `-O3` build)
   next — low risk, existing harness.
3. **B4** Asyncify advise if MIPS still disappoints after B3.
4. Open Phase C or D only if the notes force it.
5. Guest LVGL tuning (B5) last — after the emulator dial stops moving.

## Results (fill in)

| App | shift | guestFps | uploadFps | drawMs | mips | notes | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| accel_chart | 4 | | | | | | |
| lvgl_music | 4 | | | | | | |
| accel_chart | … | | | | | | |

## What not to chase for LVGL FPS

- Finishing virtio-gpu as a performance project.
- RGB565 end-to-end (small win after `-O2` memcpy).
- Main-thread 30 fps caps on the worker path (already removed).
- Blaming the JIT for wild crashes before `CONFIG_STACK_SENTINEL`
  ([`a53-lvgl-stack.md`](a53-lvgl-stack.md)).
- Treating OLED (~11 fps over I²C) numbers as evidence about ramfb LVGL.

## Related docs

- [`performance.md`](performance.md) — full lever list and build/bridge items.
- [`next-drivers.md`](next-drivers.md) — ramfb vs virtio-gpu measurements.
- [`a53-lvgl-stack.md`](a53-lvgl-stack.md) — stack overflow that looked like a
  JIT bug; why the chart was downsized.
- [`public/qemu/README.md`](../public/qemu/README.md) — JIT vs TCI, icount/MIPS
  semantics.
- Instruments: [`src/display/profile.ts`](../src/display/profile.ts),
  [`tools/profile-accel.mjs`](../tools/profile-accel.mjs).
