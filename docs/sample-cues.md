# Sample cues — plan

Teaching overlays driven from **thin macros in one new in-tree sample**: the
guest emits stable **cue** ids (and optional source anchors); the **page** owns
the prose, dock reveals, pause policy, and a packaged source view that can
highlight the lines under discussion. This is a design plan, not an
implementation.

“Coach” is the wrong metaphor (a tutor talking over you). A **cue** is the
right one: at this beat in the program, the UI takes its cue — popup, dock
reveal, pause, look-at-code.

Today the lab already teaches by pairing a sample with `primaryPanels`,
footer shell hints (“In the guest: …”), register maps, and mirrored docs.
What it does **not** have is a way for a *running sample* to mark a moment —
“I just claimed this GPIO”, “click SW0 now” — while showing the *code* that
did it. That is the gap this plan closes.

## Naming

| Thing | Name |
| --- | --- |
| Feature | **Cues** |
| Guest header | `zephyr-module/include/browser_cue.h` |
| Kconfig | `CONFIG_BROWSER_CUE` |
| Host code | `src/cue/` (parse, store, playbooks) |
| Stage UI | `CueOverlay` |
| Source UI | `SourceViewer` (also usable without cues) |
| First sample | `zephyr-module/apps/button_lab` (app id `button_lab`) |

### Macro set (complete)

Only these four. Bodies never appear in C — ids only.

```c
/* Fire event `id`. Copy / reveal / pause come from the host playbook. */
CUE("button_lab.gpio_ready");

/* Same, and pin this call site as the source anchor (__FILE__/__LINE__). */
CUE_HERE("button_lab.toggle");

/* Explicit range when the interesting code is not the call site. */
CUE_AT("button_lab.odr", "src/main.c", 88, 95);

/* Blocking pause: emit id and wait for host Continue (hard pause / Phase B). */
CUE_WAIT("button_lab.press_sw0");
```

| Macro | Emits | Blocks guest? | Source anchor |
| --- | --- | --- | --- |
| `CUE(id)` | id | no | playbook fallback only |
| `CUE_HERE(id)` | id + call-site file/line | no | call site |
| `CUE_AT(id, file, first, last)` | id + explicit range | no | given range |
| `CUE_WAIT(id)` | id (+ optional HERE/AT variants later if needed) | **yes** until ACK | playbook / paired HERE |

No `CUE_EXPLAIN`, no string bodies, no shell-hint macros in the guest. Shell
suggestions and long prose live only in host playbooks.

When `CONFIG_BROWSER_CUE=n`, all four compile to nothing.

## Goals

- Ship **one new in-tree sample** first (`button_lab`), separate from the
  packaged upstream apps — prove cues end-to-end before annotating blinky,
  shell, sensors, etc.
- Guest emits **ids** (and optional source spans); host playbooks own titles,
  bodies, reveals, pause mode.
- Package that sample’s **sources** beside its ELF/DTS for browse + 
  “pause and look at the code”.
- Prefer Cortex-M3 and Cortex-A53 without a new QEMU device for the first cut.

## Non-goals (for v1)

- Annotating or wrapping existing catalog samples (`blinky`, `shell`, …).
- A course CMS, quizzes, or branching curriculum.
- GDB / single-step.
- Replacing `primaryPanels` or panel footer hints.
- Vendoring the whole Zephyr tree as sources.

## Design sketch

```
  button_lab.c  --CUE("id")-->  cue transport  -->  page cue runtime
       |                                              |
       |                         look up playbook[id] |
       |                                              v
       +-- button_lab.src.json <-------- SourceViewer + CueOverlay
                                              |
                                    revealDockRow / soft|look|hard pause
```

| Layer | Owns |
| --- | --- |
| Guest macros | *When* (`id`); optionally *where* (`CUE_HERE` / `CUE_AT`) |
| Host playbook | *What to say*, *what to reveal*, *how to pause*, fallback ranges |
| Packaged sources | Text the SourceViewer renders and highlights |

---

## First sample: `button_lab`

A **new** app under `zephyr-module/apps/button_lab/`, not an overlay on
`samples/basic/button`. Same teaching story (SW0 → LED), but written here so
we can place `CUE_*` freely and keep upstream samples untouched.

Rough beats:

| Guest | Playbook |
| --- | --- |
| `CUE_HERE("button_lab.ready")` after GPIO ready | Reveal Keys + LED; short explain |
| `CUE_WAIT("button_lab.press_sw0")` before wait | soft/look first; hard when Phase B lands — “Press SW0” |
| `CUE_HERE("button_lab.handled")` in the handler | **look** pause on the handler lines; explain LED follow-up |

Packaging: `button_lab.elf`, `button_lab.dts`, `button_lab.src.json`, plus
`src/cue/playbooks/button_lab.ts`. Manifest + `boards.ts` entry with
`primaryPanels: ['keys', 'led', 'gpio']` on A53 (virtio-gpio) and M3 if
host-gpio interrupts are enough for the story — otherwise A53-only for v1.

No other sample gets cues until `button_lab` feels right.

### Later (explicitly not v1)

Only after `button_lab` ships: optional ids on owned `accel_chart`, then thin
wrappers or host-only boot playbooks for `blinky` / `shell` / `lsm6dso`. Same
macro set; same playbook shape. See “Later catalog” below for the teaching
order when that wave starts.

---

## Packaged app sources

Extend `tools/build-zephyr-image.sh` so tour/cue samples also emit:

```text
public/qemu/zephyr/<board>/<app>.src.json
```

For v1, only `button_lab` needs it. Include the app’s own `src/**`,
`CMakeLists.txt`, `prj.conf`, and relevant overlays — same revision as the
ELF. Example shape:

```json
{
  "sample": "zephyr-module/apps/button_lab",
  "revision": "<git sha>",
  "files": {
    "src/main.c": "/* ... */",
    "prj.conf": "..."
  }
}
```

Runtime:

1. **Consult** — Source control opens a read-only viewer (file tree + code).
2. **Look pause** — cue card + viewer scrolled to highlighted lines.

Highlights always target packaged sources, not a live GitHub `main`.

---

## Host playbooks

e.g. `src/cue/playbooks/button_lab.ts`:

```ts
export const buttonLab: Playbook = {
  'button_lab.ready': {
    title: 'Pins are ready',
    body: 'The sample claimed SW0 and LED0. Watch the Keys and LED rows.',
    revealPanels: ['keys', 'led', 'gpio'],
    pause: 'soft',
    source: { file: 'src/main.c', lines: [30, 45] },
  },
  'button_lab.press_sw0': {
    title: 'Your turn',
    body: 'Press SW0 in the Keys row, then Continue.',
    pause: 'hard', // soft until Phase B
    revealPanels: ['keys'],
  },
  'button_lab.handled': {
    title: 'The handler ran',
    body: 'That callback is what flipped the LED.',
    pause: 'look',
    source: { file: 'src/main.c', lines: [60, 72] },
  },
}
```

---

## Transport — phased

**Phase A — console OSC markers.**  
`ESC ] 787 ; <id[+path+lines]> BEL`, stripped in the PTY path before xterm.
No QEMU patch; works on M3 and A53. Soft / look pause only at first;
`CUE_WAIT` can degrade to soft or spin until a continue token.

**Phase B — dedicated cue channel.**  
virtio-browser device named `cue` (or a small MMIO mailbox on M3) so
`CUE_WAIT` blocks cleanly until ACK.

---

## Host runtime & UI

| Piece | Role |
| --- | --- |
| `src/cue/parse.ts` | Extract cue frames from PTY bytes |
| `src/cue/playbooks/*` | id → title/body/reveal/pause/source |
| `src/cue/store.ts` | Queue; dismiss / continue |
| `CueOverlay` | Stage popup: title + short body + CTA |
| `SourceViewer` | Browse + highlight packaged sources |
| `build-zephyr-image.sh` | Emit `.src.json` for `button_lab` |

UI rules: one cue card at a time; stage-level (not stickers on the
framebuffer); look pauses put code in SourceViewer, not in the popup body.

| Pause mode | Behavior |
| --- | --- |
| `auto` | Timed card |
| `soft` | Card + Continue; guest keeps running |
| `look` | soft + open/focus SourceViewer on range |
| `hard` | `CUE_WAIT` blocks until ACK |

---

## Rollout

### Milestone 0 — contract

This doc; header sketch; OSC frame; playbook types; vitest for parse + lookup.

### Milestone 1 — `button_lab` + sources + soft/look UI

- New `zephyr-module/apps/button_lab` with `CUE` / `CUE_HERE` (and `CUE_WAIT`
  as soft if needed).
- `.src.json` packaging for that app only.
- `SourceViewer` + `CueOverlay` + playbook.
- Manifest / `boards.ts` entry.

### Milestone 2 — hard `CUE_WAIT`

Phase B channel; button press beat becomes a true guest block.

### Milestone 3 — optional second wave on the catalog

Only then consider cues elsewhere. Suggested order when we do:

1. `accel_chart` (owned)  
2. `blinky` / upstream `basic_button` (host playbook or thin wrap)  
3. `lsm6dso`  
4. `shell` (host boot playbook; few guest ids)  
5. net / tracing / display  

---

## Open questions

1. A53-only for `button_lab` v1 (virtio-gpio IRQs), or also M3 host-gpio?
2. `.src.json` vs `.src/` directory of files?
3. Normalize `__FILE__` in the guest library vs a build-time path map?
4. Docs widget: auto-start the `button_lab` playbook?
5. Mute / don’t-show-again?

## Related

- Sample catalog: [`src/boards.ts`](../src/boards.ts), [`tools/samples.manifest`](../tools/samples.manifest)
- Image build: [`tools/build-zephyr-image.sh`](../tools/build-zephyr-image.sh)
- Dock reveal: [`src/lib/dockReveal.ts`](../src/lib/dockReveal.ts)
- Gallery / docs: [`sample-docs.md`](sample-docs.md)
- Bridges: [`next-drivers.md`](next-drivers.md), [`virtio-bridge.md`](virtio-bridge.md)
