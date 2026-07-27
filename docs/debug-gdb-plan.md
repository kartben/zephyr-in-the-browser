# In-page debugging (gdbstub roadmap)

Basic guest debugging without cluttering the existing UI.

## Step 1 — shipped (registers only)

Reuse the existing QMP browser-chardev monitor (already used for Pause):

- On `STOP`, ask for `info registers` via `human-monitor-command`
- Quiet UI: a PC chip next to Pause, **only while paused**; popover shows the dump
- No dock row, no stage widget, no always-on chrome

**No Step button.** QEMU 10.1’s human monitor has no one-instruction step
command (an early UI offered HMP `step`; that packet does not exist — QEMU
returns an error and the PC never moves). Real single-step lives on the
**gdbstub** (`s` / `vCont;s`), not on QMP/HMP. `one-insn-per-tb` is unrelated
(TCG translation-block size, not CPU step).

Works on current published qemu-wasm builds that already expose `monitor`.

Code: `src/hostMonitor.ts`, `src/components/PauseDebugControl.tsx`,
`src/debug/parseRegisters.ts`.

---

## Why a chardev at all?

You already have one: Pause/registers talk QMP over `-chardev browser,id=mon0`.

Gdbstub is a **different** QEMU front-end. It speaks GDB Remote Serial Protocol
bytes. On a desktop that is usually TCP (`-s` / `-gdb tcp:…`). In the browser
there is no listening TCP socket the page can dial.

QEMU already supports “put the gdbstub on any chardev” (`-gdb chardev:ID`).
Native example from upstream docs: unix socket chardev. Our analogue is a second
**browser** chardev — the same ring pattern as the monitor, pointed at gdb
instead of QMP:

```
-chardev browser,id=mon0 -mon chardev=mon0,mode=control   # QMP (have today)
-chardev browser,id=gdb0 -gdb chardev:gdb0                # RSP (next)
```

So “chardev” is not a new invention for debugging — it is the byte pipe. Without
it (or an equivalent custom ring wired into gdbstub), the stub has nowhere to
send/receive packets in wasm.

### Do we need gdbstub / a second channel?

| Capability | QMP (mon0, today) | gdbstub (gdb0) |
| --- | --- | --- |
| Pause / resume | yes | yes |
| Register dump | yes (`info registers`) | yes (`g`) |
| One-insn step | **no** | yes |
| Breakpoints | no | yes |
| Memory read/write | clumsy HMP `x`/`xp` | yes (`m`/`M`) |
| Zephyr threads later | hard | natural (mem + symbols) |

If “peek PC while paused” is enough, stop at Step 1 — no second chardev.
Step, breakpoints, and Zephyr object views need the stub, hence a second pipe.

---

## Current blocker: singleton browser chardev

All three patch series ship the same file:

| Series | Patch |
| --- | --- |
| `tools/qemu-patches/` (ARM TCI) | `0011-chardev-add-browser-backed-monitor-channel.patch` |
| `tools/qemu-jit-patches/` (AArch64 JIT) | `0014-…` |
| `tools/qemu-riscv-patches/` (RISC-V TCI) | `0012-…` |

Today the first `-chardev browser,…` claims the only JS exports
(`qemu_browser_monitor_*`). A second instance is unreachable from the page —
so monitor + gdb cannot coexist until the patch grows **named slots** (`mon0` /
`gdb0`) with parallel `qemu_browser_gdb_*` exports.

**Critical:** open gdb0 with `be_opened = false` and attach explicitly from the
page. Always-open would make gdbstub treat “client connected” at boot and freeze
the guest before our RSP client exists.

---

## Phased plan

### Phase A — Multi-channel chardev + feature gate
**(Next implementation PR if we want Step/breakpoints)**

QEMU patches (all 3 series) + `write_features` probes `"gdb"` + gated
`GDB_ARGS` in `boards.ts` / `qemu.ts`. No RSP UI yet.

Acceptance: rebuild; `features.json` has `"monitor","gdb"`; cold boot still
runs; old artifacts without `"gdb"` unchanged; monitor Pause/PC still work.

### Phase B — RSP client + Step

Thin in-page RSP (~200–400 LOC under `src/debug/gdb/`). Pause/Step/regs via
gdb when attached; QMP fallback when `"gdb"` absent. Step button returns here.

### Phase C — Software breakpoints + memory read

### Phase D — Zephyr thread list (symbols / offsets, one board first)

### Phase E — Disassembly / DWARF (optional)

Host TypeScript for B+ can land **before** the new emulator tarball (gate on
`features.has('gdb')`). Publishing the rebuilt qemu-wasm asset is what flips
gdb on.

Do not merge A+B unless you can rebuild and dogfood in one change — boot-freeze
vs RSP bugs are easier to bisect split.

---

## Control plane (once gdb exists)

When a gdb session is attached, Pause / Step / annotation pause use RSP only.
QMP stays for builds that only advertise `monitor`, and for STOP/RESUME sync if
useful. One façade so TopBar and annotations cannot diverge.
