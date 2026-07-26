# Sample coach macros — plan

Teaching overlays driven from **thin macros in guest sample code**: the guest
emits stable event IDs (and optional source anchors); the **page** owns the
prose, dock reveals, pause policy, and a packaged source view that can
highlight the lines under discussion. This is a design plan, not an
implementation.

Today the lab already teaches by pairing a sample with `primaryPanels`,
footer shell hints (“In the guest: …”), register maps, and mirrored docs.
What it does **not** have is a way for the *running sample* to narrate itself
at the right moment — “I just claimed this GPIO”, “watch the I²C write that
sets ODR”, “click SW0 now” — while showing the *code* that did it. That is
the gap this plan closes.

## Goals

- Let didactic samples (or thin wrappers) emit structured **coach events**
  from C with a small macro API — **IDs, not essay text**.
- Keep explanation bodies, titles, and richer markdown in **host-side
  playbooks** next to the sample catalog (editable without rebuilding the
  guest).
- Package each app’s **source tree** (or a curated subset) beside the ELF/DTS
  so learners can browse it, and so a “pause and look at the code” beat can
  open a viewer scrolled to the highlighted line(s).
- Prefer a path that works on **Cortex-M3 and Cortex-A53** without a new QEMU
  device for the first cut.
- Keep stock Zephyr samples runnable without coach noise when the feature is
  off (`CONFIG_BROWSER_COACH=n`).

## Non-goals (for v1)

- A full course / lesson CMS, quiz engine, or multi-step branching curriculum.
- GDB breakpoints, instruction single-step, or a general debugger UI.
- Patching every upstream Zephyr sample in-tree; coach annotations live in
  this repo (module headers + optional app wrappers / overlays).
- Replacing `primaryPanels` or panel footer hints — coach *augments* them.
- Shipping the entire Zephyr tree; only the app’s own sources (and maybe a
  short allowlisted set of headers it includes).

## Design sketch

```
  sample C  --COACH("id")-->  coach transport  -->  page coach runtime
       |                                              |
       |                         look up playbook[id] |
       |                              (title, body,   |
       |                               reveal, pause, |
       |                               source range)  |
       |                                              v
       +-- packaged sources <----------- SourceViewer + CoachOverlay
              (public/…/app.src/)              |
                                    revealDockRow / soft|hard pause
```

**Split of responsibilities (intentional):**

| Layer | Owns |
| --- | --- |
| Guest macros | *When* something pedagogically interesting happened (`id`); optionally *where* in source (`file` + `line` via `__FILE__`/`__LINE__`) |
| Host playbook | *What to say* (title/body), *what to show* (panels/rows), *how to pause*, fallback source ranges if the guest did not pin lines |
| Packaged sources | The text the SourceViewer renders and highlights |

Explanation bodies should **not** live in the guest. Strings in firmware are
painful to edit, bloat the ELF, tempt `printk`-visible leaks, and fight i18n
or tone changes. The guest only needs to say `blinky.gpio_ready`; the page
supplies the paragraph.

---

## Packaged app sources

Today `tools/build-zephyr-image.sh` ships `public/qemu/zephyr/<board>/<app>.elf`
and `<app>.dts`. Add a third artifact:

```text
public/qemu/zephyr/<board>/<app>.src.json   # or .src/ directory + manifest
```

### What to include

- The sample’s own tree: `src/**/*.{c,h,cpp}`, `CMakeLists.txt`, `prj.conf`,
  overlays/snippets that are *part of the app story* — not the whole SDK.
- For `zephyr-module/apps/*`, copy from this repo.
- For upstream `samples/...`, copy from the west Zephyr checkout at build time
  (same revision the ELF was built from).
- Optionally a small `files[]` manifest with path + sha so the UI can lazy-
  fetch per file instead of one giant blob.

Skip generated build dirs, binary blobs, and deep `zephyr/include` dumps.
If a beat must cite a Zephyr API header, link out to docs.zephyrproject.org
rather than vendoring it.

### Runtime use

1. **Consult** — TopBar / gallery / a “Source” control opens a read-only
   viewer (same dialog family as DTS): file tree + code pane. Always
   available when the `.src` artifact exists, even with coach muted.
2. **Coach highlight** — On a `look` / pause beat, open (or focus) that
   viewer, select the file, scroll to range, highlight lines. The coach card
   stays on the stage; the source pane is the “textbook,” not a sticker on
   the framebuffer.

Line numbers in playbooks must match the **packaged** sources. Build script
copies are the source of truth; do not highlight against a floating GitHub
`main` that may have drifted.

### Size

App trees are small (blinky is a few KB of C). Even packaging every sample’s
`src/` is cheap next to ELFs. Prefer one JSON per app for simple caching:

```json
{
  "sample": "samples/basic/blinky",
  "revision": "<zephyr sha or module git>",
  "files": {
    "src/main.c": "/* ... full text ... */",
    "prj.conf": "..."
  }
}
```

---

## Host playbooks (where the prose lives)

Per-sample (or per board+sample) YAML/TS beside the catalog, e.g.
`src/coach/playbooks/blinky.ts`:

```ts
export const blinky: Playbook = {
  'blinky.gpio_ready': {
    title: 'The LED pin',
    body: 'After the GPIO is ready, blinky toggles LED0 in a loop. Watch the LED row in the dock.',
    revealPanels: ['led', 'gpio'],
    pause: 'soft',           // none | soft | hard | auto
    // Fallback if the guest event omitted file/line:
    source: { file: 'src/main.c', lines: [42, 48] },
  },
  'blinky.toggle': {
    title: 'Each toggle',
    body: 'gpio_pin_toggle_dt is what flips the dock LED.',
    pause: 'look',           // pause + force source viewer
    source: { file: 'src/main.c', lines: [55, 55] },
  },
}
```

Playbooks can also drive **boot-time** beats with no guest macro (useful for
`shell`): a short queue that fires after `backend === 'running'`.

---

## Macro API (guest) — thin by design

Header e.g. `zephyr-module/include/browser_coach.h`, gated by
`CONFIG_BROWSER_COACH`. Compiles to nothing when disabled.

```c
/* Emit event id only — copy lives on the page. */
COACH("blinky.gpio_ready");

/* Same, and pin the call site as the source anchor. */
COACH_HERE("blinky.toggle");

/* Explicit range when the interesting code is not the call site
 * (e.g. macro sits just before a block you want highlighted). */
COACH_AT("lsm6dso.odr", "src/main.c", 88, 95);

/* Blocking variant when hard pause is available (Phase B). */
COACH_WAIT("button.press_sw0");
```

Wire format (conceptual): `{ id, file?, line?, endLine? }`. No title/body
strings in the guest.

| Piece | Role |
| --- | --- |
| `COACH` / `COACH_HERE` / `COACH_AT` / `COACH_WAIT` | Emit id (+ optional source span) |
| `browser_coach_emit(...)` | Transport + optional wait-for-ACK |
| `CONFIG_BROWSER_COACH` | Off by default; on for tour images |

`COACH_HERE` uses `__FILE__` / `__LINE__`. The build packaging step should
normalize paths to the keys inside `.src.json` (strip absolute west roots).

---

## Transport — phased

**Phase A — console OSC markers (recommended first cut).**  
Emit an OSC-style sequence on the console (filtered out of the visible
xterm stream), e.g.:

```text
ESC ] 787 ; <compact id[+path+lines]> BEL
```

The PTY backend already owns guest→host bytes (`src/backends/`). A thin
parser strips coach frames before they reach xterm and dispatches to a
`coachStore`. Works on every board with a serial console — including
Cortex-M3 — with **no QEMU patch**.

Pause ACK in Phase A:

1. **Soft / look pause** — UI overlay (+ source viewer); vCPU keeps running.
2. Optional guest spin until a host→guest continue token (clunky; defer if soft is enough).

**Phase B — dedicated coach channel.**  
virtio-browser `coach` (or a tiny MMIO mailbox on M3) for clean `COACH_WAIT`
request/ACK without sharing the serial stream.

---

## Host runtime & UI

| Piece | Responsibility |
| --- | --- |
| `src/coach/parse.ts` | Extract coach frames from PTY bytes |
| `src/coach/playbooks/*` | id → title/body/reveal/pause/source |
| `src/coach/store.ts` | Queue; dismiss / continue |
| `src/components/CoachOverlay.tsx` | Stage popup: title + short body + CTA |
| `src/components/SourceViewer.tsx` | Browse packaged sources; highlight ranges |
| `tools/build-zephyr-image.sh` | Also emit `<app>.src.json` |
| Hooks into `revealDockRow` | Attention blink already exists |

UI rules:

- **One coach card at a time**; queue the rest.
- Popups on the **stage** (near the terminal), not stickers on peripheral media.
- **Look pauses** split attention: coach card states the point; SourceViewer
  shows the lines — do not paste long code into the popup.
- Prefer short bodies; deep reading stays in mirrored sample docs + full source.
- Motion: dock reveal blink + one enter/exit on the coach card; smooth scroll
  in the source pane.

### Pause semantics

| Mode | Behavior | When to use |
| --- | --- | --- |
| `none` | Toast / card, no Continue | Rare; prefer `auto` |
| `auto` | Timed card, no Continue | Low-stakes narrate |
| `soft` | Card + Continue; guest runs | Blinky, network |
| `look` | soft + open/focus SourceViewer on range | “Pause and look at the code” |
| `hard` | Guest blocks in `COACH_WAIT` until ACK | Button “do this now” beats |

v1: `auto` / `soft` / `look` + packaged sources. Add `hard` with Phase B.

---

## How annotations land on samples

Upstream paths in `tools/samples.manifest` stay stock. Coach belongs in
**this** tree:

1. Macros in `zephyr-module/apps/*` (start with `accelerometer_chart`).
2. Thin wrapper apps under `zephyr-module/apps/` for a few tour demos, *or*
   a conf snippet that only enables the coach library while a tiny `.c` with
   `COACH_*` call sites is linked via `EXTRA_SOURCES` — only if wrappers get
   heavy.
3. Playbooks + packaged sources for upstream samples even before any guest
   macro exists (boot-time host playbook still works; line highlights use
   playbook `source` ranges against the packaged tree).
4. Optional `coach` snippet / `coach.conf` so tour images are explicit.

Do **not** require editing Zephyr’s `samples/` tree inside the west workspace
for day-to-day builds.

---

## Applying coach to the most didactic samples

Priority is payoff per annotation, not coverage. Start with samples that
already have a clear dock story (`primaryPanels`) and a single “aha”.

### 1. `blinky` — GPIO output heartbeat

**Teaches:** a thread toggles a GPIO LED; the dock is the hardware.

| Guest event | Playbook UI |
| --- | --- |
| `blinky.gpio_ready` | Reveal LED/GPIO; soft explain |
| `blinky.toggle` (once) | **`look`** pause on `gpio_pin_toggle_dt` in packaged `src/main.c` |

Soft/look only (blink must keep moving under soft; a one-shot look on first
toggle is enough).

### 2. `basic_button` — input → output

| Guest event | Playbook UI |
| --- | --- |
| `button.ready` | Reveal Keys + LED |
| `button.await_press` | Pause (hard if available): “Press SW0”; optional **look** at the callback / gpio-keys wait |
| `button.handled` | Explain LED follow-up; highlight handler lines |

First sample that needs a *learner action* — justifies pause-ACK.

### 3. `shell` — interactive lab bench

Macros in upstream shell are awkward. Prefer **host playbook on boot** +
packaged shell-module sources for “open the file that registers command X”.
Optional guest `coach` shell command later (`coach demo sensors`) that only
emits ids.

### 4. `lsm6dso` (and kin)

| Guest event | Playbook UI |
| --- | --- |
| `lsm6dso.before_fetch` | Reveal sensor + I²C |
| `lsm6dso.odr_set` | **`look`** at `sensor_attr_set` + explain that the dock/I²C trace reflects ODR |

Best hardware-lab story; ties API lines to bus traffic.

### 5. `accel_chart` — owned sample

Ideal first annotated codebase (`zephyr-module/apps/accelerometer_chart/`).
Packaging sources is trivial (in-repo). Macros at sensor/display ready and
first chart path; playbook bodies teach Follow-tilt without stuffing strings
into the app.

### 6. Networking suite

Host or guest ids around iface-up / DHCP bound / first connect; reveal Net
panel; **look** at the bind/connect call in packaged sources. Soft/look only —
do not hard-freeze mid-TCP.

### 7. `tracing`

Boot explain + reveal Trace overlay; optional look at the sample’s tracing
setup. Avoid pauses that stop event production.

### 8. Display / touch / LVGL

Coach off the framebuffer. Stage card + SourceViewer; focus the floating
display window for “drag here,” not badges on pixels.

### Lower priority

| Sample | Reason to wait |
| --- | --- |
| `hello_world` | Gallery + one look at `printk` is enough later |
| `philosophers` | Timing fragile on M3 TCI |
| `hsm` | Shell-driven; host playbook |
| EEPROM / SPI / RTC | Second wave after GPIO + sensors |

---

## Rollout plan

### Milestone 0 — contract

- This document; sketched header API (id-only); OSC frame; playbook type.
- Vitest for parser + playbook lookup.

### Milestone 1 — sources + host UX (no guest macros required)

- Extend `build-zephyr-image.sh` to emit `<app>.src.json` for a few apps.
- `SourceViewer` (browse + highlight).
- Host playbooks for `blinky` / `shell` firing on boot; soft + **look** pauses.
- Wire reveals to `revealDockRow`.

### Milestone 2 — guest ids on owned code

- `CONFIG_BROWSER_COACH` + thin header.
- `COACH` / `COACH_HERE` in `accelerometer_chart`.
- Playbooks supply all prose.

### Milestone 3 — tour wrappers for GPIO + IMU

- Ids in blinky/button/lsm6dso wrappers (or minimal EXTRA_SOURCES).
- Path normalization from `__FILE__` → `.src.json` keys.

### Milestone 4 — hard pause channel (optional)

- virtio-browser `coach` or MMIO mailbox; `COACH_WAIT` for `basic_button`.

---

## Concrete first slice

1. Package sources for `blinky` + `accel_chart`.  
2. SourceViewer + one host-driven **look** beat on blinky’s toggle lines.  
3. Thin `COACH_HERE("accel.ready")` in `accel_chart` with playbook body on the page.

That proves consultable sources, line highlight, id-only guest events, and
host-owned copy — without a QEMU rebuild.

---

## Open questions

1. **Upstream posture:** keep coach out-of-tree until proven?
2. **Artifact shape:** single `.src.json` vs `.src/` directory of files? (JSON
   is simpler for Pages caching; directory scales if apps grow.)
3. **Path stability:** normalize `__FILE__` at emit time in the guest library
   vs rewrite in the page using a build-time path map?
4. **Hard pause on M3:** MMIO mailbox, or soft/look-only on M3?
5. **Docs widget:** auto-start playbook when “Run in simulator” opens?
6. **Mute / don’t show again** for returning users?
7. **Multi-file highlights:** one range per beat for v1, or allow a list?

## Related

- Sample catalog: [`src/boards.ts`](../src/boards.ts), [`tools/samples.manifest`](../tools/samples.manifest)
- Image build (ELF/DTS today): [`tools/build-zephyr-image.sh`](../tools/build-zephyr-image.sh)
- Dock reveal: [`src/lib/dockReveal.ts`](../src/lib/dockReveal.ts)
- Gallery / upstream source links: [`src/sampleDocs.ts`](../src/sampleDocs.ts), [`sample-docs.md`](sample-docs.md)
- Bridge shapes: [`next-drivers.md`](next-drivers.md), [`virtio-bridge.md`](virtio-bridge.md)
