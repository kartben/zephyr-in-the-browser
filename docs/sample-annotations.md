# Samples that explain themselves

A **guided** sample carries its own teaching notes. As it runs it pops them up
over the terminal, points the device dock at whatever peripheral it is talking
about, and — where it matters — **stops the emulated machine** so you can look
before the moment passes. A lesson about `gpio_pin_toggle_dt()` is worthless
once the LED has already blinked forty times.

`zephyr-module/apps/guided_blinky` is the worked example, on all three boards.

## Writing one

Annotations are ordinary block comments. The source reads the way it would
without the feature, which is the whole point:

```c
/* @annotate led_alias [led]
 * The pin is named by devicetree, not by this file
 *
 * Nothing here says which pin the LED is on. `DT_ALIAS(led0)` resolves
 * **at compile time** to whatever the board's devicetree calls `led0`.
 */
#define LED0_NODE DT_ALIAS(led0)
```

- **`led_alias`** is the key, used to fire it. Must be a C identifier.
- **`[led]`** is optional: a `PanelKind` from `src/boards.ts`. Naming one makes
  the dock reveal that row when the annotation appears.
- The first line is the **title**, then a blank line, then a **Markdown** body.
  Inline code, bold, italic, links, bullet lists and fenced code blocks are
  supported (`src/annotations/markdown.ts`); anything more is a sign the note is
  too long for a popup.

Then fire it from a statement:

```c
int main(void)
{
        SAMPLE_SHOW_PAUSE(led_alias);
```

The split is not stylistic. A macro above a `#define` sits at file scope and
could never execute, so the comment owns *where* an annotation points and the
macro owns *when* it appears. Anchors skip past the firing macros to the next
real line, so an annotation always highlights the code it is about.

### The macros

From `<sample_annotation.h>`:

| Macro | What it does |
| --- | --- |
| `SAMPLE_SHOW(key)` | show it, keep running |
| `SAMPLE_SHOW_PAUSE(key)` | show it and stop the machine |
| `SAMPLE_REVEAL(panel)` | point the dock at a row, say nothing |
| `SAMPLE_VALUE(key, fmt, ...)` | attach a live value to the popup |
| `SAMPLE_ONCE(stmt)` | fire only on the first pass — most annotations sit inside a loop |
| `SAMPLE_END()` | walkthrough over; the sample runs free |

### Wiring a new guided app

1. Put the app under `zephyr-module/apps/<name>/`, copying the
   `add_custom_command` block from `guided_blinky/CMakeLists.txt` — it runs the
   extractor and puts the generated header on the app's include path.
2. `#define SAMPLE_ANNOTATION_DEFINE_TABLE` in exactly one `.c`, before
   including `<sample_annotation.h>` and `<sample_annotations_generated.h>`.
   Every file that fires an annotation includes them; only one instantiates the
   table.
3. `CONFIG_SAMPLE_ANNOTATIONS=y` in its `prj.conf`.
4. Add it to `tools/samples.manifest` and `src/boards.ts` (a vitest test keeps
   those two in lockstep), and to `GUIDED_SAMPLES` in
   `src/annotations/guided.ts` so the gallery shows the badge.
5. Add it to `APPS` in the `guidedAnnotations` plugin in `vite.config.ts`, so it
   works in dev without a Zephyr build.

## What it costs the firmware

Nothing that matters. `tools/extract-annotations.py` lifts the prose out into an
`annotations.json` only the browser ever reads, and leaves the guest a table of
**four bytes per annotation** — an id and the line it points at. The record that
goes out over the console is the id alone.

With `CONFIG_SAMPLE_ANNOTATIONS=n` (the default everywhere else) every macro and
the whole table compile away, so an annotated sample is byte-identical to an
unannotated one unless the lesson is asked for. That is what would make these
macros proposable upstream.

The extractor also **validates**: every `@annotate` needs a matching
`SAMPLE_SHOW*` and vice versa, so a typo is a build error rather than a popup
that silently never fires.

## How it reaches the page

Records travel as OSC 9700 escape sequences on the console UART:

```
ESC ] 9700 ; v=1;k=pause;a=3 ESC \
```

The page registers an OSC handler for 9700 and consumes what it matches, so
nothing is painted and the sample's own output is untouched. A terminal that has
never heard of the ident ignores it too, which is why an annotated sample stays
well-behaved on real hardware.

Three properties of xterm's OSC parser are load-bearing, and all three fail
*silently* if got wrong — see the comments in
`zephyr-module/subsys/sample_annotation.c`:

- **Escaping is by whitelist.** Inside an OSC payload xterm drops `0x00`–`0x1f`
  and `0x7f` without trace and never delivers `0x80`–`0xff` at all.
- **A concurrent `printk` corrupts a record invisibly.** Stray printable bytes
  are swallowed *into* the payload, and a stray ESC ends the sequence early
  while still reporting success — handing the page a truncated record it
  believes is complete. A mutex does not help, because `uart_console.c` takes no
  such lock; the emit runs under `k_sched_lock()` *and* `irq_lock()`. That is
  only tolerable because QEMU's UART models never report a full TX FIFO.
- **The numeric ident must be terminated by `;`** or the whole sequence is
  discarded before the handler sees it.

This is why annotations are **incompatible with the shell sample**: its constant
ANSI traffic is exactly the interleaving hazard above.

At startup the guest walks its table and announces every annotation the build
linked in. That is what the walkthrough outline is drawn from — and it is ground
truth, so an annotation whose fire site was compiled out never appears, however
much the JSON knows about it. If a line in the announcement disagrees with
`annotations.json`, the two artifacts came from different builds and the card
hides the source excerpt rather than highlighting the wrong line.

## Stopping the machine

`SAMPLE_SHOW_PAUSE` does not block the guest. It emits, and the *page* stops the
machine through QEMU's QMP monitor over a browser-backed chardev
(`tools/qemu-*-patches/*-chardev-add-browser-backed-monitor-channel.patch`,
`src/hostMonitor.ts`). Sending `stop` there means the big lock and the vCPU
quiescing stay QEMU's problem.

That also sidesteps a trap. A guest-side poll loop would have been pathological
on Cortex-A53, because `-icount shift=4,align=off,sleep=on` warps the virtual
clock straight to each sleep deadline — the loop would spin at *emulator* speed,
and raising the sleep value would not have helped. Freezing the machine is both
cheaper and pedagogically right: a paused lesson should stop the guest clock,
not fast-forward it.

The same bridge powers the **Pause/Resume button** in the top bar, which works
on any sample. Both are absent on an emulator built before the patch:
`public/qemu/features.json` records what a build carries, and the page checks it
before assembling argv — QEMU exits on an unknown `-chardev` backend, so
guessing wrong would stop older image tarballs booting rather than merely lose a
feature.

## Trying it without building anything

`npm run dev` lands on the mock backend, and the mock replays the walkthrough:
same records, same store, same popups, driven off the real catalog. A dev-only
Vite plugin runs the extractor over the repo's guided samples and answers the
same asset URLs a real image build would, so none of this needs a Zephyr
toolchain or the ~100 MB emulator. The mock has no machine to stop, so its
pauses only track the flag.

## Where things live

| | |
| --- | --- |
| Macros and the emitter | `zephyr-module/include/sample_annotation.h`, `zephyr-module/subsys/sample_annotation.c` |
| Extractor | `tools/extract-annotations.py` (+ `test_extract_annotations.py`) |
| Worked example | `zephyr-module/apps/guided_blinky/` |
| Wire format | `src/annotations/protocol.ts` |
| Catalog and state | `src/annotations/catalog.ts`, `store.ts` |
| Markdown subset | `src/annotations/markdown.ts` |
| UI | `src/components/AnnotationCard.tsx`, `WalkthroughOutline.tsx`, `SourceSnippet.tsx` |
| Machine pause | `src/hostMonitor.ts`, `tools/qemu-*-patches/` |
