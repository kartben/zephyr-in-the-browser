# CPU power states in the Trace panel

Source mockup: [`cpu-power-mockup.html`](cpu-power-mockup.html)

**Status.** Shipped end to end and verified against a real trace: the guest side,
the data layer, the CPU lane group in the Timeline, and the Power tab. The mockup
remains the design of record for the visual language, and it changed one decision
before any code was written (see [Ramp](#the-depth-ramp)). Not built: per-device
*runtime*-PM lanes, and anything in the dock — both deliberate, see
[Deliberately not built](#deliberately-not-built).

## Why

Zephyr gained trace hooks for power management, so a trace can now say what the
CPU's power state was over time — not merely which thread was scheduled. Nothing
in this repo knew about any of it: no `CONFIG_PM`, no PM decoding, no sample that
suspends, and no board that could.

Goal: a reader should be able to see that the machine was switched off in
`standby` for 1.2 s, how deep it went, and — the part only the devicetree can
answer — whether that was the deepest state it was *allowed* to reach.

**Non-goal: visual weight.** Every other sample in the gallery has no PM data, and
for those the panel must be byte-identical to today. The feature is invisible
until a guest emits PM events. Variant D of the mockup exists to make that claim
falsifiable rather than asserted.

## What the guest emits

Twenty CTF events, `0x147`–`0x15A`. Six of them are new here — Zephyr had trace
hooks for device *runtime* PM but none for the system-managed suspend walk, so the
event this feature most needs did not exist:

| id | event | fields |
| --- | --- | --- |
| `0x147` / `0x148` | `pm_system_suspend_enter` / `_exit` | `i32 ticks` / `+ u8 state` |
| `0x149` / `0x14A` | `pm_state_set_enter` / `_exit` | `u8 cpu, state, substate_id` |
| `0x14B`–`0x154` | `pm_device_runtime_*` | `u32 dev`, `i32 ret` |
| `0x155` / `0x156` | `pm_suspend_devices_enter` / `_exit` | — / `u32 count; u8 ok` |
| `0x157` / `0x158` | `pm_resume_devices_enter` / `_exit` | `u32 count` / — |
| `0x159` / `0x15A` | `pm_device_action_run_enter` / `_exit` | `u32 dev; u8 action` / `+ i32 ret` |

`pm_state_set_enter`/`_exit` is the spine and everything visual hangs off it. The
two bracket the SoC code that parks the CPU with no statements between, so the
**timestamp delta is the residency** — the guest never measures or reports it, and
`CONFIG_PM_STATS` is both coarser (substates collapsed) and wrong on the
IRQ-unlocked resume path. It is also the only perfectly balanced pair in the set.

### Two things not to trust

`pm_system_suspend_enter` has an early-return path in `subsys/pm/pm.c` that emits
no exit, so an unmatched enter must never be drawn as a span. It stays pending and
invisible.

`pm_system_suspend_exit`'s `state` field was **always** `PM_STATE_ACTIVE` on the
success path: `pm_system_resume()` clears the per-CPU state pointer before the
hook reads it, making a successful suspend indistinguishable from one that never
happened. Fixed in the Zephyr tree by reporting the local already latched a few
lines above for exactly this class of reason — but a trace viewer does not get to
assume its guest is new, so `cpuPower.ts` derives "did it actually suspend" from
whether a `pm_state_set` pair happened inside the round trip, and only falls back
to the field for the one case it is right about.

## Making the A53 suspend at all

`CONFIG_PM` needs `HAS_PM`, which only `soc/` ever selects — and
`soc/arm/qemu_cortex_a53` does not. The escape hatch is that
`samples/subsys/pm/latency` selects `HAS_PM` in its **own** Kconfig and supplies
`pm_state_set()` / `pm_state_exit_post_ops()` itself, which is the blessed in-tree
idiom for this (seven users). So the sample runs on this board with **zero**
changes to `soc/` or `arch/`. WFI-based suspend is not a gamble here either:
`arch_cpu_idle()` already WFIs on every idle on this target.

The ladder comes from [`snippets/cpu-power-states`](../zephyr-module/snippets/cpu-power-states/),
which is the sample's own `boards/native_sim.overlay` retargeted. Two changes were
needed, and both are the interesting part:

- `dts/arm64/qemu/qemu-virt-a53.dtsi` gives `cpu@0` and `cpu@1` **no labels**, so
  `&cpu0 { … }` does not work. The overlay reaches them by path and declares
  `cpu0:` itself.
- `cpu@1` gets the same ladder. `subsys/pm/state.c` builds its per-CPU tables from
  `DT_FOREACH_CHILD_STATUS_OKAY(/cpus)` and the dtsi declares both CPUs on every
  variant, so this keeps the second table entry from being zero-length.

The residency numbers are copied verbatim and **must stay that way**: the sample's
whole script is calibrated to those three exit latencies (a 30 ms app request
still allows standby, the test device's 20 ms blocks it, an update to 10 ms leaves
only runtime-idle). Change a number and the sample's own log lines start lying.

### The finding that cost the most time

The sample sleeps 1.1 / 1.2 / 1.3 s and expects to reach runtime-idle,
suspend-to-idle and standby in turn. On the first build it entered **runtime-idle
every single time** and the two deeper states were unreachable — while the log
kept claiming otherwise.

The trace explained itself: `pm_system_suspend_enter.ticks` was capped at ~101,
never the 120/130 the sleeps ask for. Deferred logging (the default) spawns a
processing thread that wakes every `CONFIG_LOG_PROCESS_THREAD_SLEEP_MS` = 1000 ms,
which becomes the nearest timeout and caps what the policy is offered — just over
runtime-idle's 101-tick threshold and permanently short of suspend-to-idle's 112.

`CONFIG_LOG_MODE_IMMEDIATE=y` removes the thread, and the full ladder appears.
That line in [`conf/pm-latency.conf`](../zephyr-module/conf/pm-latency.conf) is
load-bearing, not cosmetic. Worth remembering generally: **anything that wakes
periodically silently caps how deep a system can sleep**, and the tick budget in
the trace is what makes it visible.

### System-managed device PM needs devices

`CONFIG_PM_DEVICE_SYSTEM_MANAGED` has the PM core suspend every device before a
state entry — but not one driver in a `browser_bridge` build implements a PM
action callback (checked: `uart_pl011`, `display_qemu_ramfb`, all of
`drivers/virtio/`, the repo's own host-audio/mic). The walk returns `-ENOSYS` for
all of them and honestly reports suspending nothing, so the feature is
undemonstrable as-is.

Hence [`drivers/pm_demo_device.c`](../zephyr-module/drivers/pm_demo_device.c): a
prop, not a driver, whose only feature is having power management. Each instance
burns the microseconds its node asks for, which gives the walk **measurable
width** — the engineering point being that entering a deep state is not free.
Measured on the real image: **669 µs of suspend and 1.62 ms of resume** around
every deep sleep, with the three `-ENOSYS` stock devices visible alongside the
three that actually suspend.

Keep `CONFIG_PM_DEVICE` out of shared fragments: `gnss_nmea_generic.c` calls
`pm_device_init_suspended()` under it and implements only `RESUME`, so a
device-PM build of the GNSS sample would boot with a dead receiver.

## Reading the devicetree

The events carry `{cpu, state, substate_id}` — three bytes of integers. Everything
worth *knowing* is in the devicetree, so [`src/dts/powerStates.ts`](../src/dts/powerStates.ts)
reads each CPU's ordered `cpu-power-states` with names, residencies, latencies and
`zephyr,pm-device-disabled`.

The ordering job matters more than the naming. Several nodes may share one
`pm_state` and differ only by `substate-id` — STM32's `stop0/stop1/stop2` are all
`suspend-to-idle` — so the enum cannot rank them. `cpu-power-states` is ordered
shallow to deep (the default policy depends on it: it walks the list and stops at
the first state that does not fit), so **the index in that list is the depth
rank**, and it is right even when the enum is ambiguous. Without a devicetree the
rank falls back to the raw enum, which is honest: the relative depth of two
substates genuinely is unknown then.

**Numbers, not grades.** `min-residency-us` is a policy *input*, compared against
*predicted* idle time. Scoring achieved residency against it and printing a ✓/✗
would be a confident value judgement on an emulated clock. Show
`1.276s (min 1.20s, exit 30ms)`, and when residency falls short append the factual
`early wake`.

## Device names, with no debugger

The PM device events identify a device by pointer only. `name` is the **first**
member of `struct device`, and both it and the string it points at are `const`, so
they live in `.rodata` — present in the ELF at the addresses the guest sees. Two
reads and no gdb attach: [`src/debug/elfDevices.ts`](../src/debug/elfDevices.ts)
resolves `0x4000c1d0` → `pm-demo-radio` offline, before the guest has even booted.

The `__device_dts_ord_<n>` symbol alone would be a poor label — it names a
devicetree ordinal, not a device — which is why the name pointer is followed rather
than the symbol reused. Two traps: `__device_deps_start`/`_end` share the prefix
and are section bounds in a different section (offset 0 there is not a name
pointer), and the guest truncates the pointer through `(uint32_t)(uintptr_t)`, so
lookups must match the truncation.

## The reconstruction

[`src/ctf/cpuPower.ts`](../src/ctf/cpuPower.ts), accumulated in
`TraceReader.consume()` rather than derived from `Trace.events`. That is not a
style choice: `hostTrace` trims `events` in 5k batches with no generation counter,
so any cursor into it silently skips 5,000 events after each trim. The reader is
the one place that sees every event exactly once, in order, before trimming.

**ACTIVE is a gap, not a segment** — a storage decision as much as a visual one.
These events fire on every idle and `segs` is never trimmed, so storing awake
spans would double an array that only grows. It also makes the open tail trivially
correct: nothing open means the CPU is awake.

Unbalanced records are counted in a `dropped` tally, never guessed at. An exit
with no enter is dropped rather than given a synthesised start, because guessing
one is how a single segment ends up covering the whole trace.

The in-progress sleep is published to the live edge by `seal()` and withdrawn by
`unseal()` before the next decode, mirroring the thread states' provisional
bracket — including the scar recorded there about a strict `>` letting a closed
segment falsely extend forever.

`idle` (0x1E) is deliberately **not** folded in, and there is a comment in
`types.ts` saying so, so it does not get "fixed" later: it is a point event with no
exit and no cpu, so deriving an end would fabricate the one number this feature
exists to report — and it fires without `CONFIG_PM`, which would draw a power band
for guests that have none.

## The rendering

### Placement

A new `'cpu'` section **above** THREADS, behind a toolbar toggle like the queue
overlay, conditional on data exactly as `showQueues` and `hasIsr` already are.

Above rather than below, for two reasons. Top-to-bottom becomes substrate → actors
→ objects, a real gradient. The decisive one is positional stability:
`visibleLanes()` grows as threads are created during boot, so a row below the
threads slides downward while you are watching it in a live 500 ms-repaint view.
This is one array position in `timelineGeom()` if the argument loses.

### The depth ramp

One hue, sequential, deliberately in the neighbourhood of the existing `slp` cyan
— CPU suspend and thread sleep are the same idea at different scopes, so a reader
who knows "cyan = sleeping" gets the row for free. `pm_state` is ordinal, so a
ramp is correct and a categorical palette would be wrong: seven unrelated hues
cannot be ordered by eye, and there are only about three unclaimed hues left on
this canvas. Shallow states are 60 % height, deep ones full height, with the break
at `PM_STATE_STANDBY` where CPU context starts being lost.

**The mockup changed this.** A first pass put the shallow end at
`oklch(0.55 0.04 215 / 0.55)`, and against the `rgba(15,23,42,0.45)` trough a lane
reveals, runtime-idle was nearly indistinguishable from *awake* — the one
distinction the row exists to make. The ramp now starts brighter and more
chromatic. The temptation is to keep the shallow end quiet; quiet is right for the
legend, wrong for the floor of the ramp.

Exact values are in the mockup's closing `<details>`, so the implementation copies
rather than re-derives them.

### Budget

One row per CPU seen. One legend item — a three-stop gradient swatch, not seven
entries; the legend is already nine items on a wrapping 10 px line. One metrics
token, `slept N%`, deliberately a different word from the existing `CPU N%`
heuristic, which stays untouched: two adjacent percentages that sum past 100 read
as a bug. Everything else — names, residencies, thresholds, the tick budget —
lives in the tooltip and the Power tab.

### Power tab

A fourth tab on the shared window, gestures and box zoom. Two halves,
deliberately different in kind: the summary is a distribution strip plus aligned
columns (per-state share, entry count, median residency, exit latency, and
DT-declared states never entered rendered dim with `—`), and below it the device
walk on a canvas, one row per device, because that half genuinely is time-series.

**The summary spans the whole retained trace, not the Trace window; only the
device walk follows the window.** A distribution is a readout, not a chart:
shares that silently change because the shared window moved — and that can read
`0.0%` next to an entry count of `5` — are worse than no shares at all. The first
attempt kept the summary on the view and auto-fitted the window when the tab
opened, which was fragile in every variant: any "fit once" gate fires at some
arbitrary early moment (first at 14 events, then at the first suspend, ~70 ms in)
and the numbers are wrong for the rest of the session. Removing the auto-fit and
decoupling the summary fixed it outright. The device walk keeps the window
because it genuinely is a chart, and it says `N of M walks` so an empty canvas
reads as "zoom", not "nothing here".

Three things the implementation had to correct, all found by looking at real
output rather than by reasoning:

- **The residency histogram was a factor of two too coarse.** Plain log2 buckets
  put this sample's 1.09 s, 1.19 s and 1.28 s residencies all inside the 2³⁰
  octave, so all three states reported the same `med 1.074s` — three visibly
  different depths rendered identical. Now 16 sub-buckets per octave (~4.4 %),
  comfortably finer than the three significant figures the readout shows, and the
  median is taken mid-bucket rather than at its floor so readings are not biased
  low.
- **A gutter reading "state now" cannot use segments alone.** This sample's
  `main()` returns and the CPU parks in standby forever, so the enter is the very
  last event and the sealed tail has zero width: the gutter said `—` (awake) for a
  CPU that was definitively asleep. `CpuPowerTimelines.open` is now first-class
  and `pmStateAtOrOpen` falls back to it. Every transition emits an event, so "the
  last thing entered" is knowledge, not a guess.

## Deliberately not built

- **Per-device runtime-PM swim lanes** (ten of the twenty events). No longer
  blocked — names resolve offline, and the Power tab already draws one row per
  device for the *system-managed* walk. Runtime PM is a different story told on the
  same rows, and worth adding only if a sample actually exercises it; none here
  does.
- **An energy proxy.** `power-states` declares residency and latency, not µW, and
  the guest is emulated. A Σ(time × invented weight) figure with a
  physical-sounding name is the worst kind of clutter — authoritative-looking and
  fabricated. Percent time per state lets the reader weight it themselves.
- **`exit-latency-us` drawn as a sliver.** Tens of µs is sub-pixel at any window a
  user actually sits in, so it degrades to a 1 px lie rather than to nothing.
- **Deriving a band from the idle thread when PM events are absent.** That is the
  existing `cpuBusy` heuristic promoted to pixels, and a heuristic band is
  indistinguishable from a measured one once painted. No PM events, no band.
- **Extending `ThreadState` / `STATE_COLOR` / `windowStats`.** CPU power is a
  different axis with its own types.

## Verified

`samples/subsys/pm/latency` on `qemu_cortex_a53`, CTF over semihosting.

Under Zephyr's own QEMU (`west build -t run`), which proves the events:

- Full ladder, matching the sample's own predictions in every phase, including
  standby correctly blocked by the test device's 20 ms latency constraint.
- 413 events over 18.1 s decoding to the end with `desync` false; 16 segments;
  runtime-idle ≈ 1.094 s, suspend-to-idle ≈ 1.192 s, standby ≈ 1.276 s.
- 98.5 % slept, deepest standby; zero unbalanced or out-of-order records.
- Device walk: `count=3 ok=true`, 669 µs suspend / 1.62 ms resume, three
  `-ENOSYS` devices alongside; every pointer resolved to a name from the ELF.

In the browser, on the packaged `pm_latency_trace` image — which is what proves
the timing, since `-t run` uses `CONFIG_QEMU_ICOUNT` and the page does not:

- Timeline: CPU section above THREADS, one `cpu0` row, gutter reading `standby`
  at the live edge; metrics line `CPU 4% · slept 80%`.
- Power tab: `slept 96.5% deepest standby`, and the three shares sum to it —
  43.2 % / 32.5 % / 20.7 % with medians 1.097 s / 1.197 s / 1.250 s, entry counts
  7× / 5× / 3×, `policy declined 15 of 30`.
- Device rows named from the ELF: `pm-demo-sensor`, `pm-demo-radio`,
  `pm-demo-flash`, `dev_test`, `uart@9000000`, `uart@9040000`,
  `interrupt-controller`.
- Both empty states seen for real: a trace with no PM events, and a trace whose
  states are declared in devicetree but not yet entered.

`npm test` (935 tests) and `npm run typecheck` clean.
