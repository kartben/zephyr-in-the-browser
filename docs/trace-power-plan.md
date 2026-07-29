# Trace · Power tab — plan

Zephyr already has first-class power-management APIs (system PM + device
runtime PM), and SystemView already records them. **CTF does not.** The
in-page Trace panel can still show the power story that scheduling already
reveals — CPU idle residency, wake marks, duty cycle — and leave room for
real `pm_*` CTF once upstream wires those hooks.

This document is the **spec**. Phase 1 lands with the PR that introduces it;
Phases 2–3 need upstream CTF and/or a demo sample with `CONFIG_PM`.

## Goals

1. Add a Trace tab — **Power** — that makes CPU idle / busy residency readable
   the way Schedule shows threads and Networking shows sockets.
2. Share the Trace panel’s time window (zoom / pan / live-follow) so a sleepy
   sample (blinky, philosophers) can be correlated Schedule ↔ Power.
3. Stay **guest-CTF-first** for Phase 1: derive residency from scheduling
   events already in `./tracing.bin`. Do not invent host-side power models.
4. Document the CTF gap for system / device PM events so Phase 2 is an
   upstream-shaped change, not a browser invent.

## Non-goals (this feature)

- Replacing electrical-power dock widgets (INA219 current/power, MAX17048
  fuel gauge). Those stay the **sensor** view; this tab is the **CPU / PM
  subsystem** view.
- Emulating real SoC sleep currents under qemu-wasm. QEMU does not burn
  milliwatts; residency is the honest signal.
- Shipping a SystemView backend in the browser.
- Claiming `PM_STATE_*` labels before CTF emits them.

## Why this is viable now

| Layer | Status |
| --- | --- |
| Schedule CTF (`thread_switched_*`, `idle`, ISR) | Already decoded; Schedule shows idle lanes + busy % |
| Device runtime / system PM hooks | Declared in `tracing_hooks.h` |
| SystemView PM events | Implemented (`pm_system_suspend`, `pm_device_runtime_*`) |
| CTF `tracing_ctf.h` / TSDL | **No `pm_*` events** — only `idle` (`0x1E`) |
| qemu_cortex_a53 `CONFIG_PM` | Board has PSCI; full residency states need `HAS_PM` + DTS power-states — demo sample is Phase 3 |
| App UI | Tabs are `schedule \| queues \| net` only today |

Contrast with Networking: those CTF events already existed. Power is closer
to FIFO/LIFO historically — hooks exist, CTF is a no-op — **except** idle
residency can be reconstructed from the schedule stream without waiting.

## Event inventory

### Phase 1 — already in CTF (use these)

| Signal | Source | Role for UI |
| --- | --- | --- |
| Idle thread running | `thread_switched_in` where `thread_name == "idle"` | CPU idle residency band |
| App thread running | same, non-idle | CPU active band |
| ISR | `isr_enter` / `isr_exit*` | Wake ticks; time spent not idle |
| Point `idle` event (`0x1E`) | `sys_trace_idle` when `CONFIG_TRACING_IDLE` | Optional marker; Schedule reconstruction does not depend on it |
| Sleep / blocked | existing thread state machine | Why the CPU is *not* idle (detail strip) |

### Phase 2 — need upstream CTF (SystemView already has them)

| Event | Fields that matter |
| --- | --- |
| `pm_system_suspend_enter` / `*_exit` | `ticks`, `state` (`enum pm_state`) |
| `pm_device_runtime_get_*` / `put_*` / `put_async_*` | `dev` pointer, `ret`, optional delay |
| `pm_device_runtime_enable_*` / `disable_*` | device PM on/off |

Upstream work (sketch): mirror SystemView’s `sys_port_trace_pm_*` macros in
`subsys/tracing/ctf/tracing_ctf.h`, add TSDL event ids, emit from `ctf_top`,
refresh `public/tracing/metadata`. Until that lands, the Power tab must not
pretend to show `PM_STATE_SUSPEND_TO_IDLE` etc.

## Relationship to other panels

```
┌─ Schedule ──────────────────┐     ┌─ Trace · Power ───────────────┐
│ Thread Gantt · busy %       │     │ CPU residency · wake marks    │
│ “who ran”                   │     │ “was the core idle?”          │
└─────────────────────────────┘     └───────────────────────────────┘
         ▲                                      ▲
         └──────── same CTF schedule stream ────┘

┌─ Dock · INA219 / fuel gauge ┐
│ Bus voltage · SoC %         │   electrical, not PM policy
└─────────────────────────────┘
```

## Proposed UX

Fourth Trace tab label: **Power**.

### One composition (default)

Shared Trace chrome (tabs + zoom/pan/live). Body:

```
┌─ Trace ── [Timeline] [Queues] [Networking] [Power] ─── ± live ─┐
│  busy 18% · idle 82% · wakes 14 · mean idle 12.4 ms              │
│                                                                  │
│  CPU   ████░░░░█████░░░░░░██░░░░████████░░░░░░░  ← active / idle │
│        ↑      ↑         ↑ wake (ISR / thread)                    │
│  ──────── duty (bucketed busy %) ─────────────────────────────── │
│        ▁▂▃▂▁▁▁▅▇▅▁▁▁▂▁▁▁▇█▇▁▁▁                                   │
└──────────────────────────────────────────────────────────────────┘
```

**Rules**

- **One CPU residency lane** is the hero — active = warm amber, idle = cool
  slate. No card chrome; same canvas language as Networking.
- **Wake marks** sit on idle→busy edges (ISR enter during idle, or switch to
  a non-idle thread). Tick marks, not badges.
- **Duty strip** under the lane: bucketed busy fraction across the visible
  window. Collapse only if the window is empty.
- Empty / early state: “Waiting for schedule CTF…” — every traced sample
  already qualifies; no extra Kconfig for Phase 1.
- Do **not** invent milliwatt estimates. Copy talks about residency and
  wakes, not joules.

### Selection / info strip

At the playhead: mode (active/idle), time since last wake, running thread
label (via `threadRunningAt`), optional “app threads sleeping / blocked /
running” counts from `windowStats`.

### Motion

1. New busy bands bloom slightly when they enter the live edge.
2. Wake ticks flash once then settle.
3. Duty strip updates without layout thrash under live-follow.

Avoid: purple glow themes, stat-card grids, floating “deep sleep” stickers.

## Reconstruction model

New module: `src/ctf/powerResidency.ts` (+ tests), exported from
`src/ctf/index.ts`.

```ts
type CpuMode = 'active' | 'idle'

interface CpuResidencySeg {
  start: number
  end: number
  mode: CpuMode
}

interface WakeMark {
  ts: number
  reason: 'isr' | 'thread'
}

interface CpuResidency {
  segments: CpuResidencySeg[]
  wakes: WakeMark[]
  hasIdleThread: boolean
}
```

**Algorithm (Phase 1)**

1. Collect thread ids whose `thread_name` is `idle`.
2. Map `tr.segments` → `active` / `idle`; coalesce adjacent same-mode spans.
3. Wake marks:
   - `idle` → `active` segment boundary → `reason: 'thread'`
   - `isrSpans` start that falls inside an idle segment → `reason: 'isr'`
4. `residencyWindowStats(res, t0, t1)` → busy/idle %, wake count, mean idle
   bout length, bout count.
5. `dutyBuckets(res, t0, t1, n)` → `n` busy fractions for the strip.

Phase 2 extends the same module with optional `PmStateSeg[]` /
`DeviceRuntimeSeries[]` once CTF events exist — keep the CPU lane as the
default composition; PM state becomes a second lane, devices become
swimlanes below.

## UI wiring

| Piece | Change |
| --- | --- |
| `TracePanel.tsx` | `TraceTab` += `'power'`; fourth tab button |
| `PowerView.tsx` (new) | Canvas residency + duty strip + metrics |
| `powerResidency.ts` | Reconstruction + window stats |
| `hostTrace` / boards | No change for Phase 1 |
| Mock backend | Optional short schedule CTF fixture (tests cover reconstruction) |

Default tab remains Timeline. Auto-prefer Power only if we later ship a PM
demo sample.

## Implementation phases

### Phase 1 — Residency from schedule CTF (this PR)

- `reconstructCpuResidency` / `residencyWindowStats` / `dutyBuckets` + vitest.
- `PowerView` canvas aligned to Trace time window.
- Tab chrome + metrics + duty strip.
- Spec mockup kept as the visual target.

### Phase 2 — Upstream CTF for `pm_*`

- Zephyr PR: CTF emitters + TSDL + metadata refresh here.
- Decode `pm_system_suspend_*` → system PM state lane.
- Decode device runtime get/put → per-device usage-count swimlanes.
- Empty-state copy updates to mention `CONFIG_PM` / runtime PM when absent.

### Phase 3 — Demo sample + polish

- A53 sample (or snippet) with `CONFIG_PM` where the board allows, or a
  device-runtime-heavy sensor sample, shipped `_trace`.
- Optional guided tour step: idle → wake → back to idle.
- Cross-highlight: click a wake → Schedule playhead on the same timestamp.

## Risks

| Risk | Mitigation |
| --- | --- |
| No thread named `idle` | Treat all run time as active; metrics still show busy % of known span; copy notes missing idle thread |
| qemu-wasm timing ≠ wall clock | Label times as guest CTF ns (same as Schedule); never claim real mA |
| Confusing with INA219 “power” | Tab name **Power** in Trace = CPU/PM; dock keeps sensor titles |
| Users expect `PM_STATE_*` | Phase 1 copy: “CPU residency (from schedule)”; Phase 2 unlocks states |
| ISR nested in idle looks “busy” | Correct for power: ISR means the core left WFI; paint as active via wake + subsequent switches |

## Demo path

1. Phase 1 against vitest fixtures (idle ↔ worker ping-pong + ISR wake).
2. Boot A53 **blinky_trace** or **philosophers_trace** (Trace already primary).
3. Power tab should show long idle bands broken by short active / wake ticks.
4. Screenshot for the PR.

## Mockup

Visual targets (static HTML, no build):

- Phase 1 (ships with this PR): [`docs/mockups/trace-power.html`](mockups/trace-power.html)
- Phase 2 concept (upstream `pm_*` CTF): [`docs/mockups/trace-power-phase2.html`](mockups/trace-power-phase2.html)

## Status

**Phase 1 landing** on this branch:

- Spec + mockup.
- `reconstructCpuResidency` / stats / duty buckets + vitest.
- Trace tab **Power** with residency lane, wake marks, and duty strip
  (`PowerView`).

Still open: upstream CTF `pm_*` (Phase 2), PM demo sample / tour (Phase 3).
