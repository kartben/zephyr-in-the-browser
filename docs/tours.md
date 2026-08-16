# Guided tours

A **tour** is a Markdown file that teaches a sample by stopping it. Each step
names a place in the running guest, and when execution reaches it the page
freezes the machine and puts a card on screen: the prose, plus whatever the
step asked to read out of the target — values, a window of memory with the
interesting bytes lit, registers, the kernel's thread list.

The sample being taught is **stock upstream Zephyr**. Nothing is added to it,
no Kconfig is turned on, and the image is byte-for-byte the one that ships
without a tour. A tour is a file the browser reads; the guest never knows.

`tours/blinky.tour.md`, `tours/basic_button.tour.md`, and
`tours/philosophers.tour.md` are the worked examples, and being ordinary
Markdown they read as articles about those samples whether or not you ever run
them.

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

## The numbers devicetree chose, arriving at the driver

```tour
at: gpio_virtio_pin_configure | qhg_pin_configure
panel: gpio
watch:
  - controller = *$arg0 as string
  - pin = $arg1 as dec
memory:
  at: $arg0
  len: 32
  mark: 2p..3p
  note: api — the driver's function table
```

The pin the source would not tell you is right there in the second argument
register…
````

Dropping the file in is the whole wiring. Tours are picked up by an
`import.meta.glob`, so the gallery badge, the loader and the tests all discover
them from the directory — there is no list to keep in step. `npm run test`
parses every tour and fails on an authoring mistake.

**Tours ship with the page, not with the guest images.** That matters: the
images are a ~100 MB containerised Zephyr build published as a release asset and
pinned by a repository variable, so a tour bundled with *them* could not appear
until somebody rebuilt Zephyr. A tour is Markdown in this repository, it is in
the JS bundle, and a sample that has one always has one.

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
| `a \| b` | try `a`, fall back to `b` |

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

A pattern has one weakness the other spellings do not: searching source text
needs the source text, and *that* does arrive with the guest images. An image
tarball older than the tour has no `src/<app>/`, and every pattern anchor in the
tour fails. So give each one a fallback:

```yaml
at: main.c:/gpio_pin_toggle_dt/ | main.c:38
```

Alternatives are tried in order. The pattern survives upstream editing the file;
the line number survives an image build that predates the tour. Each covers the
other's failure, and a test insists every pattern anchor in a shipped tour has
one.

An anchor that does not resolve costs one step, not the tour. The rest still
run, the reason appears on the card, and a tour where *nothing* resolved says so
in the console rather than looking like a sample with no tour.

## When it fires — `when:` and friends

| Key | Default | Means |
| --- | --- | --- |
| `when:` | every hit | `first`, `hits == 4`, `hits >= 3`, `hits % 10 == 0` |
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
line, ten passes later" are both about blinky's toggle. Each counts its own
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
  - controller = *$arg0 as string
  - owner = $arg0+2p as ptr
  - stopped in = $pc as code
```

One rule holds the expression language together: **an expression names a place,
and the format says how to read what is there.**

| | |
| --- | --- |
| `_kernel` | where the symbol lives (data symbols first, then functions) |
| `_kernel+8`, `_kernel-4` | address arithmetic |
| `$arg0+2p` | `p` is one pointer width — 4 bytes on Cortex-M3 and RISC-V, 8 on Cortex-A53 |
| `*$arg0` | follow the pointer stored there |
| `**$arg0` | …twice |
| `$pc`, `$sp`, `$x0`, `$a0` | a register |
| `$arg0`…`$arg3` | the ABI's argument registers, whichever this guest uses |
| `0x40001000` | a literal |
| `(…)` | grouping |

`1p` exists because a struct's second field does not start at the same offset on
a 32- and a 64-bit guest, and the same tour runs on all three boards.

`$arg0`…`$arg3` are only trustworthy at a function's first line — break on
`z_impl_k_mutex_lock` and the mutex is right there; break ten lines in and the
compiler has long since reused the register.

Formats that name a C type **read** at the address; `addr`, `code` and `dec`
render the address itself:

| Format | Shows |
| --- | --- |
| `u8` `u16` `u32` `u64` `i8`…`i64` | the integer there, in decimal and hex |
| `bool`, `char` | one byte, as a flag or a character |
| `string` | the NUL-terminated string there |
| `ptr` | the pointer there, with the symbol it points at |
| `bytes:N` | N bytes as an inline hexdump |
| `addr` | the address itself, symbolised |
| `code` | the address as `function+offset` |
| `dec` | the value itself, in decimal and hex |

The default is `u32`. Nothing here needs type information, which is exactly why
it works against a build nobody prepared: `*$arg0 as string` walks device →
name without knowing what either struct looks like.

`dec` is for the half of an ABI's arguments that are not addresses at all — a
stack size, a pin number, a bitmask. `$arg2 as u32` on one of those goes looking
for memory *at* 2048 and reports a thread's stack size as "unreadable".

A read that fails is a value, not an error: a null pointer this early in boot is
something the reader wants to see on the card.

Optimised builds are why an expression should prefer a register to a symbol
where it can. `-O2` folds a `static const` the sample only ever passes to inline
accessors clean out of existence — blinky's `led` has a DWARF entry with no
location and no `.symtab` address at all — so `led+1p as u8` can only ever say
"no symbol `led`". Break where the pin *arrives* instead: the driver's
`pin_configure` is handed it in `$arg1`, and no optimiser can take that away.

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

### `highlight:`

Where the machine stops and what the step is *about* are different questions,
and `highlight:` answers the second:

```yaml
at: main
highlight: /GPIO_DT_SPEC_GET/
```

That step stops on the first statement of `main()` and points at a declaration
twenty lines earlier which has already run. In the excerpt the stop line carries
a `▸` in the gutter and the highlight is tinted, so the two never get confused.

| Entry | Means |
| --- | --- |
| `21` | line 21 |
| `21-24` | lines 21 to 24, inclusive |
| `/pattern/` | the first line matching |
| `/pattern/ + 3` | that line and the three after it |

Several are allowed:

```yaml
highlight:
  - /gpio_is_ready_dt/ + 2
  - /gpio_pin_configure_dt/ + 3
```

Line numbers are in the shipped source; patterns are searched in the same text
an `at:` pattern uses, so a highlight and the code under it cannot disagree. A
pattern that matches nothing is dropped rather than guessed at — a highlight
over the wrong lines is worse than none. The excerpt grows to cover whatever is
marked, up to a cap.

### `dts:`

Same spelling as `highlight:`, but against the running guest's **devicetree**
rather than the file `at:` stopped in. A step can pause on
`gpio_pin_configure_dt()` and point at the `led0` node that named the pin:

```yaml
at: main.c:/gpio_pin_configure_dt/ | main.c:32
highlight: /GPIO_DT_SPEC_GET/
dts: /led0: led_0/ + 3
```

The card shows a second excerpt, labelled with the `.dts` file name. Absence
(an older image tarball, a user ELF with no tree) is silent: the prose still
stands.

### `objects:`

The kernel objects that exist at this stop, and what state they are in.

```yaml
objects: mutex          # one type
objects: sem, mutex     # several
objects: all            # everything this guest registered
objects:                # …and which one the step is about
  type: mutex
  focus: $arg0
```

`CONFIG_OBJ_CORE` links every mutex, semaphore, message queue, mailbox, slab and
thread onto a per-type list, so this needs no addresses and no offsets: the
object cores say what exists, and the build's own DWARF says how to read each
one. A `mutex` row shows its owner, lock depth and the owner's base priority; a
`sem` row shows count and limit; a `msgq` row shows used and capacity.

`focus:` is an address expression, and the object at that address is picked out
of the list — `focus: $arg0` on `z_impl_k_mutex_lock` lights up the one this
caller is asking for, next to the five it is not.

Type names are the ones a person would write; Zephyr's four-letter codes
(`MUTX`, `SEM4`) work too, and an unrecognised one fails the test rather than
rendering as an empty list. Clicking a row opens Debug → Objects.

### `registers:` and `threads:`

```yaml
registers: pc, sp, x0
threads: yes
```

`registers:` spotlights those registers on the card (clicking one opens
Debug → CPU). `threads:` shows the object-core thread list at this stop —
states, priorities, stack use — using `CONFIG_OBJ_CORE` plus
`CONFIG_DEBUG_THREAD_INFO`, both on in every packaged image.

Both of these read the debugger's live walk rather than a copy taken when the
card was built, because the walk lands a beat after the registers do. On a busy
stop they fill in a moment after the prose.

Which is also why neither works on a `stop: no` step, and why asking for one
there is an authoring error rather than a slow card: `watch:` and `memory:` are
read while the machine is still halted, but the walks are dozens of round-trips
that have not finished by the time the guest is let go, and what is left on the
card is a spinner nothing will resolve.

## How it runs

1. The page loads the tour from its own bundle as the emulator starts.
2. A sample with a tour boots with the CPU **frozen at reset** (`-S`), and
   attaching the gdbstub is what starts it. Every anchor is resolved at that
   stop and the **first** step's breakpoint is planted before the guest has
   executed an instruction.

   Without the freeze this is a race the tour loses: opening the stub does stop
   the machine, but only once the chardev is up a second or so in, and Zephyr
   reaches `main()` long before that. A step anchored on anything the guest
   passes exactly once — `main()`, a driver's configure call, the six
   `k_thread_create()`s of a startup — was planted at an address already behind
   the program counter, and the tour sat there waiting for a breakpoint that
   could never fire again. If the stub never comes up at all, the monitor
   starts the machine instead, and the sample runs untoured rather than frozen.
3. Each stop is matched to a step by address. A stop nobody claims — the
   reader's own breakpoint, or the Pause button — is left alone.
4. A firing step reads its values, reveals its panel, and puts up the card.
   Continue plants the next step's breakpoint and *then* resumes.

**One breakpoint at a time.** A breakpoint traps on every pass, so a tour with
all its steps planted has the guest trapping into the page at addresses nobody
is looking at yet, for the whole run, including steps the reader never reaches.
Planting one ahead also keeps the tour in the order it was written, rather than
firing whichever step the guest happens to reach first.

The cost is that a step whose location goes by before its turn comes round is
missed — the guest reaches it again on a later pass, or not at all. For a
document with numbered steps that is the right trade, and the ordering is what
the prose already implies.

The plant is always awaited *before* the resume. `main()` and the line after it
are microseconds apart on a JIT guest, so a plant racing a resume loses the step
reliably rather than occasionally.

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

A **curriculum** is a longer path around one use case, not a stock sample
explaining itself. That shape is proposed in [curriculum-plan.md](curriculum-plan.md).
