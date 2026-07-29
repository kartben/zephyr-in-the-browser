# In-page debugging (gdbstub)

Basic guest debugging without cluttering the existing UI.

**Status: shipped**, from the QMP register peek through to breakpoints, memory,
Zephyr threads, a call stack and a dedicated panel. What is left is Phase G,
which was optional when it was written. This started as a roadmap and is now
the record of how the debugger is wired —
[`public/qemu/README.md`](../public/qemu/README.md) points here for what the
`gdb0` chardev is for.

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
- Façade `src/debug/control.ts` — Pause/Step/tours use gdb when attached,
  else QMP
- Step button appears only when gdb session is live

**Phase C (breakpoints + memory)**

- Software breakpoints (`Z0`/`z0`) and memory read (`m`) — only with gdb.
  They started in the pause popover tabs and moved to the Debug panel in
  Phase F. Memory turned out to be writable too: `M` behind an editable hex
  dump, gated on paused.

The emulator rebuild this needed has happened — `features.json` in a packaged
build lists `monitor`, `gdb` and `hci` (see `../public/qemu/README.md`). The
fallback is still live code, so a page served an older tarball stays on Step 1
automatically rather than breaking.

---

## Why a chardev?

Desktop gdbstub uses TCP. The browser has none. Upstream already supports
`-gdb chardev:ID`; a second browser chardev is that byte pipe (same pattern as
today’s monitor).

---

## Later phases

Written as “later”; D through F have since landed, and each says so. G has not.

### Phase D — Zephyr threads (CONFIG_DEBUG_THREAD_INFO, shipped)

Same introspection ABI OpenOCD uses. Guests build with
`CONFIG_DEBUG_THREAD_INFO=y` (`zephyr-module/conf/debug-threads.conf`), which
selects `THREAD_MONITOR` + `THREAD_NAME` and emits:

- `_kernel`
- `_kernel_thread_info_offsets` (and size / count helpers)

Packaged images ship **unstripped** ELFs so the page can resolve those symbols,
read the offset table, then decode thread fields over gdb memory reads.
**Threads** tab: name, priority, state, stack size (matched via SP → ELF stack
symbols, or `stack_info` when DWARF has it), and Memory links for the stack /
TCB. Where object cores are unavailable — a custom ELF built without
`CONFIG_OBJ_CORE` — a PENDING thread's `base.pended_on` is still matched back
to a named `STT_OBJECT` in the ELF (`src/debug/elfWaitObjects.ts`), so a row
reads *pending on `my_sem`* with a Memory link.

Packaged images also set `CONFIG_OBJ_CORE=y`. The debugger reads
`_k_obj_core_desc_list_start/end` for type metadata, then walks the live
`z_obj_type_list` and every per-type object list. The Threads tab uses the
object-core thread list as its authoritative inventory and object cores resolve
wait targets by type instead of by symbol-name guesses.

At the GDB stub's initial boot stop, descriptor address ranges seed static
objects before `z_obj_core_init_all()` has necessarily linked the live lists.
The snapshot is retained when boot resumes, then later stops merge in dynamic
objects and statistics from the initialized lists.

The **Objects** tab groups every linked kernel object by four-character type ID,
names static objects from the ELF, decodes useful fields for common primitives,
and links object/core/pointer addresses into Memory. Packaged images also enable
`CONFIG_OBJ_CORE_STATS`; raw stats buffers and their decoded thread/CPU/system
cycle or memory-pool fields appear under each participating object. Custom ELFs
without statistics remain supported.

Trace queue swim lanes, depth charts, and the queue synoptic reuse the live
object-core bounds for fixed-capacity objects (for example `k_msgq.max_msgs`
and `k_stack` entry capacity). Their vertical/fill scales therefore reflect the
kernel's actual limit; failed-put inference and observed-peak scaling remain
clearly marked fallbacks for images or object types without a fixed bound.

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

Break / CPU / Stack / Memory / Threads moved out of the pause-only TopBar
popover into a dockable panel, so breakpoints can be set while the guest is
running. Under gdb the TopBar shows nothing at all — `PauseDebugControl` is
QMP-only now. See [`debug-panel-plan.md`](debug-panel-plan.md) and the
interactive mockup [`mockups/debug-panel.html`](mockups/debug-panel.html).

### Phase G — Disassembly / DWARF line tables (optional, still open)

Source-line labels (`main.c:37`) per frame would need `.debug_line`. Half of
that has since been built for a different reason: `src/debug/dwarfLines.ts`
runs the line-number program to an `address ↔ file:line` index so a tour can
say *break at `main.c:31`* about a stock build. It is wired to the tour DSL and
not to the Stack tab, which still labels frames `symbol+offset`.

A disassembler is the part nobody has written, and it is the part that would
make Step over exact — see the comment in `hostGdb.ts` explaining why the
current implementation has to step first and ask questions afterwards.

---

## Control plane

When gdb is **attached** (RSP handshake succeeded): Pause / Step / tour
pause → RSP only, and everything lives on the Debug panel — its status line
reads `gdb · waiting…` until a session is live, then `paused` or `running`.

When not (missing feature, attach race, or handshake failure): QMP only, and
the TopBar keeps its Pause chip, whose popover is headed `CPU · QMP`. No
Debug panel, so no Step / breakpoints / memory. One façade
([`src/debug/control.ts`](../src/debug/control.ts)) so TopBar and tours cannot
diverge.
