# In-page debugging (gdbstub roadmap)

Basic guest debugging without cluttering the existing UI.

## Step 1 — shipped here

Reuse the existing QMP browser-chardev monitor (already used for Pause):

- On `STOP`, ask for `info registers` via `human-monitor-command`
- Quiet UI: a PC chip next to Pause, **only while paused**; popover has Step + dump
- No dock row, no stage widget, no always-on chrome

Works on current published qemu-wasm builds that already expose `monitor`.

## Step 2 — real gdbstub

Upstream QEMU already has a gdbstub. Native `-s` / `-gdb tcp:…` does not work in
the browser (no TCP). The intended shape is:

```
-chardev browser,id=gdb0 -gdb chardev:gdb0
```

Blockers in this tree today:

1. **Singleton browser chardev** — the first `chardev-browser` claims the only
   JS-exported rings (`tools/qemu-*-patches/*-chardev-add-browser-backed-monitor-channel.patch`).
   Monitor + gdb need named channels (e.g. `id=mon0` / `id=gdb0`) with per-id
   exports.
2. **RSP client** in the page (or a thin wasm helper) speaking GDB remote
   protocol over that chardev.
3. **Control-plane rules** — Pause/QMP `stop`/`cont` vs gdb `vCont` must not
   desync; when a gdb session is attached, Pause should defer to it.

After that: breakpoints, memory read/write, and (later) Zephyr object views
(threads, etc.) via symbol-aware reads — same long-term goal as a desktop
`west debug` session, but inside the tab.
