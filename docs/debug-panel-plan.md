# Dedicated Debug panel — plan

Today’s debug UI is a pause-only popover on the TopBar chip. That was fine for
QMP register peeks; it is wrong for a gdb session: breakpoints are a *setup*
action, and the Threads / Memory / CPU surfaces have outgrown a 30rem dropdown.

## Goals

1. **Set / clear breakpoints while the guest is running** (no pause first).
2. Give debug a **home** that matches Trace / dock panels — not a TopBar popover.
3. Keep TopBar quiet: run control stays visible; deep inspection lives in the panel.
4. Host-only UI work where possible; no Zephyr/QEMU changes for this phase.

## Current constraints (facts)

| Action | Needs pause today? | Why |
| --- | --- | --- |
| Pause / Continue / Step | Yes (by definition) | RSP `vCont` |
| Insert / remove SW breakpoint | **No** — `hostGdb.addBreakpoint` only requires `attached` | UI hides Break until paused |
| Read registers / memory / threads | Yes | Stub only answers `g` / `m` while stopped |

So the “must pause to set a BP” feeling is a **UI gate**, not an RSP limit.

## Proposed UX

### TopBar (always)

```
[ Pause | Continue ]  [ Step ]   PC chip when paused (opens panel → CPU)
                                  · or “2 bps” badge when running
```

- Pause / Step stay in the TopBar (muscle memory, annotations).
- PC chip still appears when paused; clicking it **focuses the Debug panel**
  (CPU section) instead of opening a nested popover.

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

- **Breakpoints section is never gated on pause.** Symbol typeahead + hex add
  work while running; list shows labels from the ELF.
- **CPU / Memory / Threads** only populate when paused. While running, show one
  short line: “Pause to inspect registers, memory, and threads” — not empty
  tabs that look broken.
- **One job per section:** Breakpoints = manage stops; CPU = registers;
  Memory = peek; Threads = RTOS walk.
- **No cards in the “hero”** of the panel — flat list + compact toolbar, same
  language as Trace / dock rows.
- Width ~22–26 rem docked; undockable via existing `PanelFrame`.

### Why a panel, not a bigger popover

- Popovers close on outside click and vanish on Continue — bad for BP setup.
- Trace already taught users “open from Panels, leave it up.”
- Room for Threads + Memory without fighting the TopBar.

## Implementation sketch (no calendar estimates)

### 1. Control plane (small)

- Keep `addBreakpoint` / `removeBreakpoint` pause-free (already).
- Expose `breakpoints` + `attached` to a panel that mounts whenever gdb is live.
- Optional: `focusDebugSection('cpu'|'break'|…)` for the PC chip → panel handoff.
- `readMemory` / register refresh stay pause-gated.

### 2. UI split

| Piece | Role |
| --- | --- |
| `PauseDebugControl` | Shrink to Pause + Step + PC chip (no popover) |
| `DebugPanel` (new) | Breakpoints always; CPU/Mem/Threads when paused |
| `dockStore` / Panels menu | `stage:debug` (or device-class row) like `stage:trace` |
| Boards seed | Open Debug expanded when `features.gdb` and sample is shell/blinky? Optional |

Reuse existing panes from `PauseDebugControl.tsx` (BreakpointsPane, MemoryPane,
ThreadsPane, RegisterGrid) — move, don’t rewrite.

### 3. Running vs paused chrome

- Header status: `running` / `paused` + `pcLabel` when known.
- Step button: TopBar *and/or* panel header when paused (one is enough — prefer
  TopBar only to avoid duplication).

### 4. Out of scope for this pass

- Disassembly view (Phase E).
- Hardware BPs, watchpoints.
- Editing source; DWARF locals browser.
- QMP-only boards: no Debug panel (same as today — no Break/Mem/Threads).

## Migration / risk

- Popover removal is a behaviour change — document in the panel’s empty state
  (“Breakpoints live here now”).
- QEMU gdbstub: confirm `Z0` while running on wasm builds (host already allows
  it; if a stub rejects, fall back to “pause → set → continue” with a toast).
- Panel + Trace + docks: don’t auto-open Debug on every sample — user opens it,
  or seed only for gdb-featured boards.

## Mockup

Interactive HTML (toggle Running / Paused):

[`docs/mockups/debug-panel.html`](mockups/debug-panel.html)

Open locally in a browser — no build step.
