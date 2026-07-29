# Dedicated Debug panel

**Status: shipped.** `src/components/DebugPanel.tsx` is the panel this argued
for; Phase F in [`debug-gdb-plan.md`](debug-gdb-plan.md) is the same work seen
from the gdbstub side. All four goals were met — one of them differently, and
the note under Rules says how. Kept for the reasoning: the constraints table
below is why the panel exists at all.

The debug UI *was* a pause-only popover on the TopBar chip. That was fine for
QMP register peeks; it was wrong for a gdb session: breakpoints are a *setup*
action, and the Threads / Memory / CPU surfaces had outgrown a 30rem dropdown.

## Goals

1. **Set / clear breakpoints while the guest is running** (no pause first) — met.
2. Give debug a **home** that matches Trace / dock panels — not a TopBar
   popover — met; `PanelFrame` under `stage:debug`, toggled from the Panels menu.
3. Keep TopBar quiet: run control stays visible; deep inspection lives in the
   panel — met, and further than written. Under gdb the TopBar shows *nothing*,
   run control included; it only keeps its Pause chip on QMP-only boards.
4. Host-only UI work where possible; no Zephyr/QEMU changes for this phase — met.

## Current constraints (facts)

| Action | Needs pause? | Why |
| --- | --- | --- |
| Pause / Continue / Step | Yes (by definition) | RSP `vCont` |
| Insert / remove SW breakpoint | **No** — `hostGdb.addBreakpoint` only requires `attached` | the old UI hid Break until paused; the panel does not |
| Read registers / memory / threads | Yes | Stub only answers `g` / `m` while stopped |

So the “must pause to set a BP” feeling is a **UI gate**, not an RSP limit.
That was the whole premise, and it held: `BreakpointsPane` has no notion of
`paused` anywhere in it.

## Proposed UX

### TopBar

- **gdb**: no Pause / Step / PC — those live on the Debug panel.
- **QMP-only**: Pause + PC chip (register popover) stays in the TopBar.

### Debug panel (new — dock / stage, like Trace)

Opened from **Panels** menu as `Debug` (gdb-only; hidden when stub unavailable).

**Layout — one composition, two modes:**

```
┌─ Debug · gdb ───────────────────────────── [−][↗][×] ─┐
│  ● running · shell_process · 2 breakpoints              │
│                                                         │
│  BREAKPOINTS                          ← always live     │
│  [ shell_process____ ▾ ] [Add]                          │
│  ● shell_process          4003b018                 [×]  │
│  ● k_msleep+0x2c          4001a044                 [×]  │
│                                                         │
│  ── pause to inspect ─────────────────────  (running)   │
│  CPU · Memory · Threads dimmed / locked                 │
└─────────────────────────────────────────────────────────┘

┌─ Debug · gdb ───────────────────────────── [−][↗][×] ─┐
│  ■ paused · shell_process+0x14 · Step                   │
│                                                         │
│  BREAKPOINTS                          ← still editable  │
│  …                                                      │
│                                                         │
│  CPU   Memory   Threads             ← tabs when paused  │
│  ┌─────────────────────────────────────────────────┐    │
│  │  PC / SP / LR chips · GPR grid · tooltips       │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

**Rules**

- **Breakpoints** always available (running or paused). No helper copy.
- **CPU / Mem / Threads** appear only when paused — omit them while running
  (no “pause to inspect…” banner). **This one was reversed in practice.** The
  tabs stay mounted and go dim (`opacity-45`, `pointer-events-none`,
  `aria-disabled`) while the guest runs, still showing the last stop. Dropping
  the snapshot on resume would also drop the baseline the next stop diffs
  against — the hex pane lights bytes the guest just changed, and it can only do
  that against something. Dimming says “stale” without throwing it away.
- Tooltips carry detail (reg roles, wait targets); the chrome stays labels + values.
- Flat list + compact toolbar — same language as Trace / dock rows.
- Width ~22–26 rem docked; undockable via existing `PanelFrame`.
- Tab labels stay short: **CPU · Mem · Threads** (not “Memory”). A **Stack**
  tab joined them later, from Phase E of [`debug-gdb-plan.md`](debug-gdb-plan.md).

### Why a panel, not a bigger popover

- Popovers close on outside click and vanish on Continue — bad for BP setup.
- Trace already taught users “open from Panels, leave it up.”
- Room for Threads + Memory without fighting the TopBar.

## Implementation sketch (no calendar estimates)

Followed as sketched, with the deviations noted per item.

### 1. Control plane (small)

- Keep `addBreakpoint` / `removeBreakpoint` pause-free (already).
- Expose `breakpoints` + `attached` to a panel that mounts whenever gdb is live.
- Optional: `focusDebugSection('cpu'|'break'|…)` for the PC chip → panel handoff.
  Landed as `src/lib/debugUi.ts`, and it grew more callers than the one it was
  proposed for: a Trace lane hands a thread to the Threads tab, and tour cards
  hand off to CPU and Mem.
- `readMemory` / register refresh stay pause-gated.

### 2. UI split

| Piece | Role | Status |
| --- | --- | --- |
| `PauseDebugControl` | QMP-only: Pause + regs popover; hidden when gdb | as written |
| `DebugPanel` (new) | Pause/Step in header; Breakpoints always; CPU/Mem/Threads when paused | built, but the inspect tabs dim rather than disappear |
| `dockStore` / Panels menu | `stage:debug` (or device-class row) like `stage:trace` | as written |
| Boards seed | Open Debug expanded when `features.gdb` and sample is shell/blinky? Optional | done by sample, not by board: the `_trace` twins list `debug` in `primaryPanels` |

Reuse existing panes from `PauseDebugControl.tsx` (BreakpointsPane, MemoryPane,
ThreadsPane, RegisterGrid) — move, don’t rewrite.

### 3. Running vs paused chrome

- Header status: `running` / `paused` + `pcLabel` when known.
- Pause / Step: panel header actions only (not duplicated in TopBar).

### 4. Out of scope for this pass

Still out:

- Disassembly view (Phase G in [`debug-gdb-plan.md`](debug-gdb-plan.md); this
  said Phase E, from before the later phases were renumbered).
- Hardware BPs, watchpoints.
- Editing source; DWARF locals browser. Editing *memory* did land — the hex
  dump takes writes while paused — and the register grid names the formals of
  the function at PC, but neither is a locals browser.
- QMP-only boards: no Debug panel (same as today — no Break/Mem/Threads).

## Migration / risk

- Popover removal is a behaviour change — Breakpoints live in the Debug panel
  (Panels menu → Debug). Under gdb the TopBar keeps nothing at all: Pause, Step
  and the PC chip are all on the panel header, as the TopBar section above says.
  This bullet used to claim the opposite.
- QEMU gdbstub: confirm `Z0` while running on wasm builds (host already allows
  it; if a stub rejects, fall back to “pause → set → continue” with a toast).
  The stub accepted it, so the fallback was never written — a rejected `Z0`
  just surfaces as “Breakpoint rejected” next to the Add box.
- Panel + Trace + docks: don’t auto-open Debug on every sample — user opens it,
  or seed only for gdb-featured boards.

## Status

Built: `DebugPanel`, `stage:debug` in the Panels menu; Pause/Step on the panel
header; TopBar Pause only for QMP.

### Since

- Inspect tabs are **CPU · Stack · Mem · Threads**. Stack is the call stack —
  see Phase E in [`debug-gdb-plan.md`](debug-gdb-plan.md) for how frames are
  recovered and why some are labelled guesses.
- Panel header carries **Step into · Step over · Step out** (Step out is
  disabled until a caller frame exists).
- Threads rows link to **stack**, which unwinds that thread in the Stack tab,
  and a pending thread names the kernel object it is pended on.
- Stack frames carry a **run to** action — a one-shot breakpoint at that frame,
  then Continue.
- The Mem hex dump takes edits in **either column** — hex or ASCII; typing in
  the ASCII gutter walks along so a string goes in as a string. It also has a
  directional **search** that can be cancelled mid-sweep, since every step of it
  is an RSP round-trip.
- `tools/screenshot-debug.mjs` shoots the panel against a synthetic stopped
  session (dev-only `__zephyrGdbForceSession`), so the paused surfaces can be
  reviewed without a ~100 MB emulator build.

## Mockup

Interactive HTML (toggle Running / Paused):

[`docs/mockups/debug-panel.html`](mockups/debug-panel.html)

Open locally in a browser — no build step.
