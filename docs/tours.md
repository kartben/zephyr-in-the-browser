# Guided tours

A **tour** is a Markdown file that teaches a sample by stopping it. Each step
names a place in the running guest, and when execution reaches it the page
freezes the machine and puts a card on screen: the prose, plus whatever the
step asked to read out of the target — values, a window of memory with the
interesting bytes lit, registers, the kernel's thread list.

The sample being taught is **stock upstream Zephyr**. Nothing is added to it,
no Kconfig is turned on, and the image is byte-for-byte the one that ships
without a tour. A tour is a file the browser reads; the guest never knows.

`tours/blinky.tour.md` and `tours/philosophers.tour.md` are the worked
examples — and, being ordinary Markdown, they read as articles about those
samples whether or not you ever run them.

## Writing one

Create `tours/<sample-id>.tour.md`, where `<sample-id>` is the app id from
`src/boards.ts`. Front matter names the tour; each `##` heading starts a step;
a fenced ` ```tour ` block under the heading holds the stage directions; the
rest of the section is the prose.

````markdown
---
tour: Blinky, explained
sample: samples/basic/blinky
---

Optional introduction.

## Nothing in this file says which pin

```tour
at: main
panel: gpio
watch:
  - controller = **led as string
  - pin = led+1p as u8
memory:
  at: led
  len: 16
  mark: 0..1p
  note: pointer to the GPIO controller
```

The machine is stopped on the first statement of `main()`, and `led` already
holds everything this sample will ever know about the hardware…
````

Then add the id to `TOURED_SAMPLES` in `src/tours/guided.ts`, so the gallery
badges it. That is the whole wiring: no build step, no CMake, no rebuild of
anything. `npm run test` parses every tour and checks the two lists agree.

The directive block is a strict subset of YAML — `key: value`, `- item` lists,
one level of nested mapping. Anything the parser accepts, a real YAML parser
reads the same way.

## Where a step breaks — `at:`

| Spelling | Means |
| --- | --- |
| `main.c:/toggle_dt/` | the first line of `main.c` matching the pattern |
| `main.c:31` | line 31 of `main.c` |
| `gpio_pin_configure` | that function, past its prologue |
| `main+0x1c` | that function, at an offset |
| `0x40001234` | that address |

**Prefer the pattern form.** These samples track Zephyr `main`, so a line number
is a fact about a moment in somebody else's git history; `/toggle_dt/` still
means what it meant. (CodeTour learnt the same lesson and grew the same
feature.)

All five are resolved against the ELF the page already fetched to boot the
guest: `.symtab` for symbols, `.debug_line` for source lines. Zephyr builds
with debug info, so the mapping is simply *there* — nothing is generated and
nothing is prepared. That also means a tour can break in code it does not own:
`at: z_impl_k_sleep` stops inside the kernel, and the sample never knows.

A line anchor lands on the first code **at or after** the line, the same as
gdb's `break file:n`, because an optimised build has no code for a comment or a
folded branch. The card shows where it actually landed.

An anchor that does not resolve costs one step, not the tour. The rest still
run, and the reason appears on the card in dev.

## When it fires — `when:` and friends

| Key | Default | Means |
| --- | --- | --- |
| `when:` | every hit | `first`, `hits == 4`, `hits >= 3`, `hits % 40 == 0` |
| `repeat:` | `no` | keep the breakpoint after the step has fired |
| `stop:` | `yes` | `no` shows the card and lets the machine run on |

`when:` is DAP's `hitCondition`, spelt out. Hits are counted **in the browser**:
the breakpoint traps on every pass, and the ones that do not match are let go
again. No `SAMPLE_ONCE()` is compiled into the guest, and the sample has no idea
any of it is happening.

**A rejected hit is not free, only cheap.** It costs one register read and a
continue — the machine never publishes a pause, so nothing else runs: no memory
peek, no thread walk, no stack unwind, no card. That is a few milliseconds plus
the stub's poll interval, which is fine at blinky's one-blink-a-second and not
fine on something taking a mutex thirty times a second.

So match the condition to the rate:

- **Cold breakpoint** (once a second, a few times a run): `hits % 10 == 0` with
  `repeat: yes` is comfortable, and the card can come back round after round.
- **Hot breakpoint** (a kernel entry point, anything in an inner loop): use
  `hits == N`. It fires once and the breakpoint is lifted, so the cost stops
  there. A `repeat:` step on a hot address keeps trapping for the rest of the
  run, and the guest will feel it.

Two steps may share an address — "the line that does the work" and "the same
line, forty passes later" are both about blinky's toggle. Each counts its own
hits; the first whose condition fires is the one shown.

## What the card shows

Everything below is optional, and a step with none of it is just prose.

### `panel:`

A `PanelKind` from `src/boards.ts` (`gpio`, `led`, `i2c`, `net`, …). The device
dock unhides that row, expands it and blinks it, so the reader's eye has
somewhere to go when the machine stops.

### `watch:`

A list of `label = expression as format` rows, read at the stop.

```yaml
watch:
  - controller = **led as string
  - pin = led+1p as u8
  - stopped in = $pc as code
```

One rule holds the expression language together: **an expression names a place,
and the format says how to read what is there.**

| | |
| --- | --- |
| `led` | where the symbol lives (data symbols first, then functions) |
| `led+8`, `led-4` | address arithmetic |
| `led+1p` | `p` is one pointer width — 4 bytes on Cortex-M3 and RISC-V, 8 on Cortex-A53 |
| `*led` | follow the pointer stored there |
| `**led` | …twice |
| `$pc`, `$sp`, `$x0`, `$a0` | a register |
| `$arg0`…`$arg3` | the ABI's argument registers, whichever this guest uses |
| `0x40001000` | a literal |
| `(…)` | grouping |

`1p` exists because a struct's second field does not start at the same offset on
a 32- and a 64-bit guest, and the same tour runs on all three boards.

`$arg0`…`$arg3` are only trustworthy at a function's first line — break on
`z_impl_k_mutex_lock` and the mutex is right there; break ten lines in and the
compiler has long since reused the register.

Formats that name a C type **read** at the address; `addr` and `code` render
the address itself:

| Format | Shows |
| --- | --- |
| `u8` `u16` `u32` `u64` `i8`…`i64` | the integer there, in decimal and hex |
| `bool`, `char` | one byte, as a flag or a character |
| `string` | the NUL-terminated string there |
| `ptr` | the pointer there, with the symbol it points at |
| `bytes:N` | N bytes as an inline hexdump |
| `addr` | the address itself, symbolised |
| `code` | the address as `function+offset` |

The default is `u32`. Nothing here needs type information, which is exactly why
it works against a build nobody prepared: `**led as string` walks spec →
device → name without knowing what any of those structs look like.

A read that fails is a value, not an error: a null pointer this early in boot is
something the reader wants to see on the card.

### `memory:`

Opens a hexdump of guest memory inside the card, with a byte range picked out.

```yaml
memory:
  at: $arg0
  len: 32
  mark: 2p..3p
  note: owner — the thread currently holding this fork
```

`at:` is an address expression. `mark:` is a `start..end` range of offsets from
it, end-exclusive, and both ends are expressions too — so `2p..3p` means the
third pointer-sized field whatever the word size is. The card offers to hand the
same address to **Debug → Mem**, where it can be scrolled, searched and edited.

### `registers:` and `threads:`

```yaml
registers: pc, sp, x0
threads: yes
```

`registers:` spotlights those registers on the card (clicking one opens
Debug → CPU). `threads:` shows the kernel thread list at this stop — states,
priorities, stack use — which needs `CONFIG_DEBUG_THREAD_INFO`, on in every
packaged image.

## How it runs

1. The page loads `<app>.tour.md` beside the ELF, at the same time it starts the
   emulator.
2. Opening the gdbstub stops the machine once, early in boot. The tour plants
   every step's breakpoint at that stop, before the guest can run past `main()`.
3. Each stop is matched to a step by address. A stop nobody claims — the
   reader's own breakpoint, or the Pause button — is left alone.
4. A firing step reads its values, reveals its panel, and puts up the card.
   Continue resumes.

Steps are planted all at once, not one ahead of the reader: a tour is not
necessarily linear, and whichever step the guest reaches first is the one that
fires.

The tour needs the gdbstub, so it needs an emulator built with the dual-channel
chardev patch (`public/qemu/features.json` lists `"gdb"`). Without it the sample
runs normally and the tour never starts.

## Trying it without building anything

`npm run dev` lands on the mock backend, which has no machine to break in. It
walks the steps on a timer instead — real prose, real panel reveals, real
outline — and every card that would have read the target says so rather than
inventing a number. Enough to write and read a tour on a bare checkout.

A dev-only Vite plugin serves `tours/*.tour.md` at the same URLs a real image
build would. Source excerpts come from your Zephyr workspace when there is one
(`ZEPHYR_WS`, default `~/zephyrproject`); without it the prose stands alone.

## What it costs the firmware

Nothing at all — not "nothing that matters". There is no macro, no table, no
Kconfig, no generated header and no extra section. `tools/build-zephyr-image.sh`
copies the tour and the sample's sources next to the image; the ELF is
untouched.

That is the difference from the annotation system this replaces, which put the
prose's *ids* in the guest, fired them from macros in the sample, and smuggled
records out over the console as OSC escape sequences — where a concurrent
`printk` could corrupt one invisibly, and where the shell sample's ANSI traffic
made the whole feature unusable. None of those constraints survive: the machine
is inspected from outside, so anything that runs can be toured, shell included.

## Where things live

| | |
| --- | --- |
| The tours | `tours/*.tour.md` |
| File format | `src/tours/parse.ts` |
| Anchors | `src/tours/anchors.ts`, `src/debug/dwarfLines.ts` |
| Expressions | `src/tours/expr.ts` |
| Hit conditions | `src/tours/when.ts` |
| Engine | `src/tours/store.ts` |
| Gallery badge | `src/tours/guided.ts` |
| UI | `src/components/TourCard.tsx`, `tour/TourHexdump.tsx`, `tour/TourOutline.tsx` |
| Debugger underneath | `src/hostGdb.ts`, `src/debug/` — see [debug-gdb-plan.md](debug-gdb-plan.md) |
| Packaging | `tools/build-zephyr-image.sh`, the `tours()` plugin in `vite.config.ts` |
