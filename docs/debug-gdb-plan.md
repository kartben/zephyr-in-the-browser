# In-page debugging (gdbstub roadmap)

Basic guest debugging without cluttering the existing UI.

## Step 1 — shipped (PR #151)

Reuse the existing QMP browser-chardev monitor (already used for Pause):

- On `STOP`, ask for `info registers` via `human-monitor-command`
- Quiet UI: a PC chip next to Pause, **only while paused**; popover has Step + dump
- No dock row, no stage widget, no always-on chrome

Works on current published qemu-wasm builds that already expose `monitor`.

Code: `src/hostMonitor.ts`, `src/components/PauseDebugControl.tsx`,
`src/debug/parseRegisters.ts`.

## Goal after Step 1

```
-chardev browser,id=mon0 -mon chardev=mon0,mode=control
-chardev browser,id=gdb0 -gdb chardev:gdb0
```

Page speaks QMP on `mon0` (annotations, STOP/RESUME sync) and GDB RSP on
`gdb0` (halt/continue, registers, step, software breakpoints, memory). One
control plane for run/stop once gdb is attached.

---

## Current blocker: singleton browser chardev

All three patch series ship the same file:

| Series | Patch |
| --- | --- |
| `tools/qemu-patches/` (ARM TCI) | `0011-chardev-add-browser-backed-monitor-channel.patch` |
| `tools/qemu-jit-patches/` (AArch64 JIT) | `0014-chardev-add-browser-backed-monitor-channel.patch` |
| `tools/qemu-riscv-patches/` (RISC-V TCI) | `0012-chardev-add-browser-backed-monitor-channel.patch` |

Today `chardev/char-browser.c` keeps a single `static BrowserChardev
*browser_channel`. The first `-chardev browser,…` claims the only JS exports
(`qemu_browser_monitor_*`). A second instance is a live Chardev that the page
cannot reach — so monitor + gdb cannot coexist.

Ring sizes / poll (keep unless gdb proves otherwise):

- `BROWSER_IN_SIZE` 1024, `BROWSER_OUT_SIZE` 16384, `BROWSER_POLL_MS` 20
- Drain timer is `QEMU_CLOCK_REALTIME` (must stay: virtual clock freezes on stop)

---

## Design: named channels (`mon0` + `gdb0`)

### Recommended shape (opinionated)

**Label-keyed dual slots**, not a fully dynamic N-channel API and not
first-wins.

On `browser_chr_open`:

1. Read `CHARDEV(chr)->label` (the `id=` from argv).
2. If `label == "mon0"` → assign `browser_mon`.
3. If `label == "gdb0"` → assign `browser_gdb`.
4. Unknown ids: still a working Chardev (timer + rings) but no JS exports
   (log once). Reject a second open of the same label.

Keep the existing `qemu_browser_monitor_*` KEEPALIVE exports as thin wrappers
around `browser_mon`. Add a parallel `qemu_browser_gdb_*` family for
`browser_gdb`. Same six entry points as today:

| Export | Role |
| --- | --- |
| `qemu_browser_{monitor,gdb}_feed` | page → QEMU, one byte |
| `qemu_browser_{monitor,gdb}_ring` | out-ring base |
| `qemu_browser_{monitor,gdb}_ring_size` | out-ring size |
| `qemu_browser_{monitor,gdb}_{read,write}_index` | free-running indices |
| `qemu_browser_{monitor,gdb}_set_read_index` | publish page read cursor |

Why not a generic `qemu_browser_chardev_*(int slot, …)` yet:

- Matches every other bridge in this tree (fixed export names, no handles).
- Keeps Step-1 `hostMonitor` working against **old** published artifacts that
  only have `monitor_*` (and against new builds that still export the aliases).
- Two channels is the actual product need; a slot registry can wait until a
  third consumer appears.

### Critical: gdb OPENED must not freeze boot

Monitor correctly sets `*be_opened = true` so QMP gets its OPENED event.

QEMU's gdbstub typically treats CHR_EVENT_OPENED as “client connected” and
often **stops the VM**. Because browser chardevs have no far-end handshake,
opening gdb0 with `be_opened = true` at chardev create can pause the guest
before the page’s RSP client exists.

**Required behavior for gdb0 only:**

- Open with `*be_opened = false`.
- Add `qemu_browser_gdb_attach(void)` / `qemu_browser_gdb_detach(void)` that
  fire `qemu_chr_be_event(…, CHR_EVENT_OPENED|CLOSED)` when the page’s RSP
  session starts/stops.
- Monitor stays always-open.

Acceptance: cold boot with both MONITOR_ARGS and GDB_ARGS reaches the shell
without an artificial stop; Pause still works via QMP before gdb attach.

### Optional later: larger gdb out-ring

Register + short `m` replies fit in 16 KiB. Bulk memory / XML target
descriptions may want `BROWSER_OUT_SIZE` 64 KiB on the gdb slot only. Defer
until a real overrun shows up (page should detect `head - tail` saturation).

### Files that change in all three patch series

Same content in each series’ chardev patch (replace / amend the existing
`*-chardev-add-browser-backed-monitor-channel.patch` — do **not** add a
follow-on patch that conflicts; regenerate the one file so rebase stays
one-patch-per-concern):

1. `chardev/char-browser.c` — dual slots, label match, gdb deferred OPENED,
   `qemu_browser_gdb_*` (+ attach/detach), keep `qemu_browser_monitor_*`.
2. `include/chardev/char-browser.h` — declare the new prototypes.
3. `chardev/meson.build` / `qapi/char.json` — **unchanged** (already list
   `browser`).

No other QEMU patches required for argv `-gdb chardev:gdb0` (upstream
gdbstub already speaks chardev). Confirm TCI + JIT softmmu still build
`gdbstub` under `--without-default-features` / trimmed `browser.mak` device
sets; if a Kconfig drop appears, add `CONFIG_GDBSTUB` (or whatever the 10.1
name is) to the three `configs/devices/*/browser.mak` patches.

### Breaking changes to `hostMonitor`

| Change | Break? |
| --- | --- |
| Keep `qemu_browser_monitor_*` as mon0 wrappers | **No** — Step 1 keeps working |
| Rename-only to generic chardev API | **Yes** — avoid |
| Second `-chardev browser,id=gdb0` before mon0 with old singleton | Would steal channel — fixed by label match |
| Page attaches gdb and also QMP `stop`/`cont` | Semantic desync — see control plane |

Refactor worth doing in the **same** host PR as multi-channel (optional but
clean): extract `src/debug/browserChardev.ts` (or `src/hostChardev.ts`) with
`attachChannel(mod, 'monitor' | 'gdb')` drain/feed helpers shared by
`hostMonitor` and the future RSP transport. `hostMonitor` keeps QMP parsing;
it does not learn RSP.

---

## GDB argv + `features.json`

### Argv (`src/boards.ts`)

Mirror MONITOR_ARGS:

```ts
export const MONITOR_ARGS = [
  '-chardev', 'browser,id=mon0',
  '-mon', 'chardev=mon0,mode=control',
]

export const GDB_ARGS = [
  '-chardev', 'browser,id=gdb0',
  '-gdb', 'chardev:gdb0',
]
```

Do **not** add `-S` (freeze at startup). Attach-on-demand from the page after
boot; use RSP interrupt / `vCont` for halt.

### Backend (`src/backends/qemu.ts`)

```ts
const features = await emulatorFeatures()
let args = [...board.args]
if (features.has('monitor')) args = [...args, ...MONITOR_ARGS]
if (features.has('gdb')) args = [...args, ...GDB_ARGS]
```

Order: monitor chardev before gdb chardev is fine either way once labels
matter; keep monitor first for readability.

Attach after `factory.default`:

```ts
attachHostMonitor(instance)
if (features.has('gdb')) attachHostGdb(instance) // Phase B
```

### Probe (`tools/build-qemu-wasm.sh` → `write_features`)

Today only probes `qemu_browser_monitor_feed` and writes a single feature.
Accumulate:

```bash
write_features() {
  local dest="$1" binary="$2"
  local -a feats=()
  if grep -q "qemu_browser_monitor_feed" "$dest/$binary.js" 2>/dev/null; then
    feats+=("\"monitor\"")
  fi
  if grep -q "qemu_browser_gdb_feed" "$dest/$binary.js" 2>/dev/null; then
    feats+=("\"gdb\"")
  fi
  local joined
  joined=$(IFS=,; echo "${feats[*]}")
  printf '{\n  "features": [%s]\n}\n' "$joined" > "$dest/features.json"
}
```

Same rule as monitor: **never** put `-gdb` / second browser chardev on argv
unless features say so — unknown backends / missing stubs exit QEMU and brick
old release tarballs.

`tools/package-emulator.sh` already packs whatever is under `public/qemu/`
(including `features.json`); no packaging logic change beyond rebuilding.

---

## RSP client

### Protocol subset (Phase B/C)

QEMU gdbstub is the server; the page is a minimal **client**.

| Need | Packets |
| --- | --- |
| Framing | `$…#CS`, optional `+`/`-` ack (QEMU often works with `QStartNoAckMode`) |
| Handshake | `qSupported`, `qXfer:features:read` *or* hardcode arch reg maps; `H`/`Hg0` |
| Halt | `\x03` (break) → expect `T`/`S` stop reply |
| Continue | `c` or `vCont;c` |
| Step | `s` or `vCont;s:p…` |
| Registers | `g` / `G` (and later `p`/`P`) |
| Software BP | `Z0,addr,kind` / `z0,…` (`kind` = 2 or 4 by arch) |
| Memory | `maddr,length` / `M…` |

Defer: watchpoints (`Z2`/`Z3`), reverse dbg, multi-thread `qfThreadInfo` until
Zephyr phase, file I/O, tracepoints.

### Module shape — use `src/debug/` (already has `parseRegisters.ts`)

```
src/debug/
  parseRegisters.ts          # Step 1 HMP text (keep for QMP fallback)
  browserChardev.ts          # shared ring drain/feed for mon|gdb
  gdb/
    rspCodec.ts              # escape, checksum, packet parse/encode (~80 LOC)
    rspClient.ts             # request/response queue over chardev (~150–250 LOC)
    regs.ts                  # arch reg maps: cortex-m / aarch64 / riscv32
    session.ts               # attach, halt/cont/step, bp set, readRegs/mem
  hostGdb.ts                 # poll loop, public API, feature gate (like hostMonitor)
```

`PauseDebugControl` should depend on a small façade (`src/debug/control.ts` or
exports from `hostGdb` + `hostMonitor`) so the button does not import RSP
internals.

### Library vs thin client — **write ~200–400 LOC**

Existing npm “gdb” packages wrap a **spawned gdb process** (MI), not raw RSP
over bytes. Wokwi-style `gdbclient.ts` snippets are TCP-oriented and still
small enough to reimplement. A dependency buys almost nothing in the browser
chardev world and adds Node/`net` assumptions.

Write a thin client. Steal framing ideas from Wokwi’s public gdbclient if
useful; keep ownership in-tree with vitest on codec + fake ring.

### Polling / latency

- QEMU drain: 20 ms realtime timer (already).
- Page: `hostPoll` floor is **100 ms** (`src/hostPoll.ts`). That makes every
  RSP RTT ≥ ~100–120 ms — fine for Pause/Step/BP, painful for dumping pages of
  memory.
- Recommendation: gdb session uses a **private 20 ms** `setInterval` (same
  pattern as hot `hostNet`), unregistered on detach. Do not lower the shared
  beat for everyone.

Ack mode: negotiate `QStartNoAckMode` early to cut `+` traffic on the rings.

---

## QMP vs GDB control plane — prefer one

| Actor | Today (Step 1) | With gdb attached |
| --- | --- | --- |
| Pause button | QMP `stop` / `cont` | RSP break / `vCont;c` |
| Step | HMP `step` via QMP | RSP `s` / `vCont;s` |
| Registers | HMP `info registers` | RSP `g` + `regs.ts` |
| Annotations | `monitor.pause()` / `resume()` | Same façade → gdb if attached |

**Rule:** if `hostGdb` has an active session (`features.gdb` and attach
succeeded), Pause / Step / annotation pause **must not** send QMP
`stop`/`cont`/`step`. QMP remains connected for STOP/RESUME *events* only (or
even those become advisory — gdb stop replies are source of truth for
`paused`).

Implementation sketch:

```ts
// debug/control.ts
export function pause() {
  if (gdb.sessionActive()) gdb.interrupt()
  else monitor.pause()
}
```

Annotations (`src/annotations/store.ts`) already call `monitor.pause()` —
point them at the façade so walkthroughs and the TopBar cannot diverge.

When gdb is **not** in features.json: behavior stays exactly Step 1.

Detaching gdb (session end): resume via RSP if stopped, then fall back to QMP
for further Pause. Do not leave the stub holding the VM.

---

## UI evolution (keep quiet)

Stay inside `PauseDebugControl` — still no dock row, no stage widget.

| State | UI |
| --- | --- |
| Running, no gdb feature | Pause only (today) |
| Running, gdb available | Pause only (no extra chrome) |
| Paused | PC chip + popover |
| Popover Phase B | PC, Continue (Play already on button), Step, register dump from `g` |
| Popover Phase C | + breakpoint list (addr chips, remove), “Break at…” hex field |
| Later | Disassembly window (separate surface; not Phase B) |

Do **not** show a breakpoint list while running. Optional: tiny “N bps”
affordance only while paused if count > 0 — skip if it feels like clutter.

PC parsing: prefer RSP register maps; keep `parseRegisters` as fallback when
only QMP is available.

---

## Zephyr objects (later — Phase D+)

Realistic path (do not block B/C on this):

1. **ELF in MEMFS** — guest ELFs are already fetched into Emscripten FS for
   `-kernel`. The same bytes are available to the page before/without FS
   (`fetchAsset` in `qemu.ts`). Parse a minimal symbol table (not full DWARF
   at first): `k_sys_work_q`, `_kernel`, thread list head.
2. **Known offsets / layouts** — Zephyr `struct k_thread` changes by version
   and `CONFIG_*`. Prefer reading through **gdb helper scripts** semantics
   (what `west debug` uses) only after we can eval expressions — hard in-page.
   Shorter path: ship a tiny JSON “debug info” next to the sample (thread list
   offset, `offsetof` fields) generated at image-build time.
3. **Thread list UI** — RSP `qfThreadInfo` if QEMU/Zephyr RTOS awareness
   exists; otherwise memory-walk with symbols. Show in the pause popover as a
   compact list, not a dock panel.
4. **DWARF** — last. Browser DWARF parsers exist but are heavy; defer until
   symbols + memory read are proven.

Phases: D = symbols + memory-backed thread list for one board; E = DWARF /
source line if still wanted.

---

## Rebuild / CI cost

| Work | Needs qemu-wasm rebuild? | CI today |
| --- | --- | --- |
| Phase A patches + `write_features` | **Yes** (all three targets you ship) | Not in `.github/workflows/ci.yml` — local/`release.sh` + `package-emulator.sh` → `qemu-wasm-emulator.tar.gz`; Pages pulls via `EMULATOR_RELEASE` |
| Host TS feature gates, RSP, UI | **No** | `ci.yml` typecheck + vitest |
| Guest ELFs / Zephyr debug JSON | Images only | `zephyr-images.tar.gz` |

**Host TS can land before artifacts:** gate on `features.has('gdb')`. Without
the new tarball, page behaves as Step 1. Publish emulator asset when Phase A
patches are in; then enable gdb paths automatically.

Workflows to touch when publishing: whatever you use for `tools/release.sh`
emulator half; `pages.yml` only needs a newer `EMULATOR_RELEASE` tag. No need
to put full qemu-wasm compile on every PR (too slow / too much RAM).

Expect a full multi-target emulator rebuild (ARM TCI + AArch64 JIT + optional
riscv32) — hours, not minutes; same cost class as any chardev patch bump.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Singleton migration / argv order | Label match; keep `monitor_*` aliases |
| gdb OPENED stops guest at boot | Deferred OPENED + explicit `gdb_attach` |
| ARM / AArch64 / RISC-V reg maps | `regs.ts` per `board.arch`; tests with canned `g` payloads; QMP dump remains fallback |
| TCI vs JIT | Same gdbstub / chardev code; verify stop/step on both ARM TCI and A53 JIT |
| RSP over 100 ms shared poll | Private 20 ms gdb poll; NoAckMode |
| Out-ring overrun on large `m` | Cap read size in UI; grow gdb out-ring if needed |
| Dual control plane desync | Single façade; annotations use it |
| Trimmed device configs drop gdbstub | Check browser.mak / Kconfig on first rebuild |
| Old artifacts | features.json empty/`monitor` only → no GDB_ARGS |

---

## Phased plan

### Phase A — Multi-channel chardev + feature gate
**(Recommended first implementation PR after Step 1)**

**Scope:** QEMU patches (all 3 series) + `write_features` + `GDB_ARGS` gated in
`boards.ts` / `qemu.ts`. Optional: extract `browserChardev.ts`. No RSP UI yet
(or only a debug-only `attach` that continues immediately to prove OPENED).

**Files:**

- `tools/qemu-{patches,jit-patches,riscv-patches}/*chardev-add-browser*`
- `tools/build-qemu-wasm.sh` (`write_features`)
- `src/boards.ts` (`GDB_ARGS`)
- `src/backends/qemu.ts` (feature append)
- `docs/debug-gdb-plan.md` (this file)
- `public/qemu/README.md` (one paragraph on monitor+gdb channels)

**Acceptance:**

1. Rebuild arm + aarch64; `features.json` contains `"monitor","gdb"`.
2. Boot with both arg blocks; guest runs (no stuck-at-reset).
3. Existing Pause + PC chip + HMP step still work (monitor aliases).
4. Old artifact without `"gdb"` still boots (no second chardev on argv).
5. Manual: gdb ring feed/drain smoke from console using new exports.

**Why first:** unblocks everything; TS/RSP can develop against a published
artifact without rewriting patches twice. Smallest binary-changing PR.

### Phase B — RSP client + control-plane switch

**Scope:** `src/debug/gdb/*`, `hostGdb.ts`, façade for pause/step/regs;
`PauseDebugControl` uses façade; annotations call façade.

**Acceptance:**

1. With gdb feature: Pause halts via RSP; chip PC matches `g`.
2. Step advances PC; Continue runs; QMP `stop`/`cont` not used while attached.
3. Without gdb feature: identical to Step 1.
4. Vitest covers rspCodec + session against a fake byte pipe.
5. Annotation pause/dismiss still stops/resumes the guest.

### Phase C — Software breakpoints + memory read

**Scope:** `Z0`/`z0`, popover BP list while paused; `m` for hex dump / symbol
prep.

**Acceptance:**

1. Set BP at address → Continue → hits → chip shows PC at BP.
2. Remove BP; Continue does not re-hit.
3. Memory read of vector table / known ELF symbol returns expected bytes.
4. UI still quiet (no dock).

### Phase D — Zephyr thread list (one board)

**Scope:** symbol/offset helper from image build or minimal ELF symtab; memory
walk; popover list.

**Acceptance:** named threads for `qemu_cortex_m3` hello/shell; documented
limits when CONFIG layout drifts.

### Phase E — Disassembly / DWARF (optional)

Only after C is solid. Capstone-wasm or server-precomputed listings; not on
the critical path.

---

## Recommended sequencing (opinionated)

1. **PR1 = Phase A** (this doc’s “first PR”) — ship emulator tarball.
2. **PR2 = Phase B** — host-only once artifacts exist (or land TS gated first,
   then flip when tag updates).
3. **PR3 = Phase C** — breakpoints + memory.
4. **Later** Phase D/E.

Do not combine A+B in one PR unless the author can rebuild and dogfood
end-to-end in the same change; the failure modes (boot freeze vs RSP bugs)
are easier to bisect when split.

Step 1 remains the QMP fallback forever for builds that only advertise
`monitor`.
