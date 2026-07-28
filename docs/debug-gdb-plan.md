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

## Later phases

### Phase D — Zephyr threads (CONFIG_DEBUG_THREAD_INFO, shipped)

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

### Phase E — Call stack + richer stepping (shipped)

**Stack tab** (`src/debug/callStack.ts`, `components/debug/StackPane.tsx`).
No CFI parsing; two passes, and the pane labels which one produced the frames:

| Pass | When | Confidence |
| --- | --- | --- |
| Frame-pointer chain | `CONFIG_FRAME_POINTER=y` (packaged builds set it) | exact |
| Link register | frame 0's caller before it is spilled | exact |
| Stack scan | anything else — words that land *inside* a function | plausible |

The scan's one rule is that a return address is never at a function's first
instruction (`offset > 0`), which throws out vtables, thread entry points and
ISR vector words. Frames deeper than the cap, or past the scan window, are
reported as `truncated` rather than silently dropped.

The picker also unwinds a **parked thread** from its saved SP (scan only — its
registers live in a switch handle we do not decode), which is how you see what
a blocked thread was doing without resuming it.

**Run control** grew Step over and Step out, both one-shot breakpoints:

- *Step out* breaks at frame #1 and continues.
- *Step over* steps one instruction, then asks whether the return-address
  register now points just past where it was; if so that step entered a call,
  so it breaks at the return address and continues.

Recursion can stop these one level shallower than intended — no frame is
tracked across the resume. Pause always recovers.

### Phase F — Dedicated Debug panel (shipped)

See [`debug-panel-plan.md`](debug-panel-plan.md) and the interactive mockup
[`mockups/debug-panel.html`](mockups/debug-panel.html). Move Break / CPU /
Memory / Threads out of the pause-only TopBar popover into a dockable panel so
breakpoints can be set while the guest is running.

### Phase G — Disassembly / DWARF line tables (optional)

Source-line labels (`main.c:37`) per frame would need `.debug_line`; the ELF
already ships it and `dwarfFormals.ts` has the section plumbing. That would
also make Step over exact, since a disassembler can see a call coming.

---

## Control plane

When gdb is **attached** (RSP handshake succeeded): Pause / Step / annotation
pause → RSP only. Label in the popover reads `gdb`.

When not (missing feature, attach race, or handshake failure): QMP only. Label
reads `CPU · QMP`. Step / breakpoint / memory tabs stay hidden. One façade so
TopBar and annotations cannot diverge.
