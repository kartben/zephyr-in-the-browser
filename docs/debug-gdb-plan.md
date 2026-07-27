# In-page debugging (gdbstub roadmap)

Basic guest debugging without cluttering the existing UI.

## Shipped

### Step 1 — QMP registers (no rebuild)

- On `STOP`, `info registers` via QMP; PC chip next to Pause while paused
- No Step on QMP — HMP has no one-instruction step

### Phases A–C — gdbstub path (this work)

**Phase A (QEMU patches + feature gate)**

- Dual browser chardev slots: `id=mon0` (QMP, always open) and `id=gdb0`
  (gdbstub, closed until `qemu_browser_gdb_attach()`)
- Parallel exports `qemu_browser_gdb_*` (+ attach/detach)
- `features.json` may list `"gdb"`; `GDB_ARGS` appended only then
- Patches: `tools/qemu-{,jit-,riscv-}patches/*chardev-add-browser*`

**Phase B (host RSP + control plane)**

- Thin RSP client: `src/debug/gdb/*`, `src/hostGdb.ts`
- Façade `src/debug/control.ts` — Pause/Step/annotations use gdb when attached,
  else QMP
- Step button appears only when gdb session is live

**Phase C (breakpoints + memory)**

- Software breakpoints (`Z0`/`z0`) and memory read (`m`) in the pause popover
  tabs — only with gdb

**Needs an emulator rebuild** before `"gdb"` appears in `features.json`. Until
then the page stays on Step 1 automatically.

---

## Why a chardev?

Desktop gdbstub uses TCP. The browser has none. Upstream already supports
`-gdb chardev:ID`; a second browser chardev is that byte pipe (same pattern as
today’s monitor).

---

## Still later

### Phase D — Zephyr threads (CONFIG_DEBUG_THREAD_INFO)

Same introspection ABI OpenOCD uses. Guests build with
`CONFIG_DEBUG_THREAD_INFO=y` (`zephyr-module/conf/debug-threads.conf`), which
selects `THREAD_MONITOR` + `THREAD_NAME` and emits:

- `_kernel`
- `_kernel_thread_info_offsets` (and size / count helpers)

Packaged images ship **unstripped** ELFs so the page can resolve those symbols,
read the offset table, then walk `_kernel.threads` over gdb memory reads.
**Threads** tab: name, priority, state, stack size (matched via SP → ELF stack
symbols, or `stack_info` when DWARF has it), and Memory links for the stack /
TCB. Semaphores / mutexes / object cores can come later.

### Phase E — Disassembly / DWARF (optional)

---

## Control plane

When gdb is **attached** (RSP handshake succeeded): Pause / Step / annotation
pause → RSP only. Label in the popover reads `gdb`.

When not (missing feature, attach race, or handshake failure): QMP only. Label
reads `CPU · QMP`. Step / breakpoint / memory tabs stay hidden. One façade so
TopBar and annotations cannot diverge.
