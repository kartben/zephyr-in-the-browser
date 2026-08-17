# Plan: a curriculum, starting with an environmental node

**Status: proposed.** This is a product and teaching plan, not an
implementation. Existing guided tours stay as they are: a stock sample that
explains itself in three to five stops. This document argues for a second
shape, a **curriculum**, and sketches the first one around a field
environmental node.

## The gap

The gallery is a flat list of apps. That is the right picker when you already
know you want LPS22HH or HTTP Server. It is the wrong first hour when you are
learning Zephyr: there is no path, no through-line, and no reason the next
sample follows the last.

Guided tours close part of that gap for a single sample. Blinky, Button, and
Dining Philosophers each pause the **guest** and point at one idea. They are
not a course. A 14-step tour of blinky would still be a tour of blinky.

What is missing is a **curriculum**: one use case, a named sequence of
lessons, and a running system you can play with while the lessons reveal how
it was put together.

## Recommendation

**Boot one complete environmental-node app from lesson 1. Explain it in the
order you would write it. Teach CMake, Kconfig, and overlays as desk steps,
not as fake rebuilds.**

In other words: the "full app, comment on aspects" instinct is right about
*what boots*. The "build as we go" instinct is right about *explanation
order*. Neither extreme should win on its own.

| Approach | Verdict |
| --- | --- |
| One complete app, tour comments on aspects in any order | Too much at once. The dock lights up with every peripheral and the learner has no assembly story. |
| Incremental rebuild (add a `.c` file, edit `CMakeLists.txt`, boot a new image) | The page cannot compile Zephyr. Shipping 12 to 15 staged ELFs would bloat the image tarball. Rebooting between lessons loses the dock and the story. Pretending each step rebuilt the guest is a lie. |
| Hop the gallery (Blinky, then LPS22HH, then RTC, then HTTP, then a capstone) | Useful later as optional side quests. As the main path it is a lot of reboots, and each sample is a different app, not "your node growing." |
| **Complete node + assembly-order lessons + desk steps for build files** | **Do this.** One boot, one dock, one story. Live stops still freeze the guest. Build-system teaching is documentary and honest. |

The capstone is a real multi-file application under
`zephyr-module/apps/env_node/`, not a stock sample with a long comment. The
files (`main.c`, `sensors.c`, `display.c`, `net.c`) are all in the image from
the first lesson. The curriculum visits them in the order a person would add
them, and the CMakeLists desk step points at a real `target_sources` list
rather than a hypothetical one.

Existing short tours do not change. The gallery stays the catalog. A
curriculum is a new entry point, not a replacement for "pick an app."

## Constraints (facts)

These are why the recommendation is shaped this way.

1. **The page does not build firmware.** Tours ship with the JS bundle;
   images are a prebuilt tarball. A lesson that "adds a source file" can show
   the file. It cannot run `west build`.
2. **A tour is one sample.** The engine plants one breakpoint at a time
   against the ELF that booted. Switching apps mid-lesson is a reboot, not a
   step. See [tours.md](tours.md).
3. **Sources shipped today are `*.c` / `*.h` from `src/`**, and only when a
   tour exists (`tools/build-zephyr-image.sh`). `CMakeLists.txt`, `prj.conf`,
   and overlays are not on the page yet. Desk steps need that copy widened.
4. **`at:` is required today.** `src/tours/guided.test.ts` fails a step with
   no anchor. Desk steps need `at:` to become optional.
5. **A53 is the focus board** ([focus.md](focus.md)). The first curriculum
   ships there. RISC-V can follow once the tour is stable. Cortex-M3 is out.
6. **The dock is the flattened devicetree.** Extra chips are extra cards the
   learner has to look past. The node's bill of materials stays tight.
7. **No humidity part.** The page models TMP112, LM75, LPS22HH, ISL29035,
   INA219, and the IMUs. There is no BME280 / SHT3x. Pressure + temperature +
   light is a credible environmental node without adding silicon.

## The node

A field station that reads the air, stamps the reading, shows it locally, and
serves it on the LAN. Parts the page already models, drivers Zephyr already
has.

| Role | Part | Why this one |
| --- | --- | --- |
| Pressure and temperature | LPS22HH | Stock sensor sample already in the gallery. One chip, two channels. |
| Light | ISL29035 | Second sensor on the same I²C bus. Same `sensor_sample_fetch` / `sensor_channel_get` API. |
| Timestamp | PCF8523 | Stock RTC. A reading without a time is a demo; a reading with a time is a log. |
| Local readout | JHD1313 16×2 | Short lines: `23.1C 101.3kPa` / `420 lux 12:04`. The dock already paints it. |
| Status and demand sample | `gpio-leds` + `gpio-keys` | LED blinks on a fresh sample. SW0 forces one. Reuses the Blinky / Button vocabulary. |
| Report | HTTP server on `192.0.2.1` | JSON of the latest reading. Network already knows how to fetch a `guestHttpUrl`. |

Leave out of v1 (say so in the last lesson, do not solder them on):

- LittleFS / SPI flash (second bus, a curriculum of its own)
- Fuel gauge and INA219 (power, not environment)
- GNSS (outdoor flavor, UART, not needed to teach the node)
- Humidity (no modelled part)
- MQTT (no broker on the page; HTTP GET from Network is the thing you can do)

### App layout

```
zephyr-module/apps/env_node/
  CMakeLists.txt          # target_sources for each .c below
  prj.conf                # SENSOR, RTC, AUXDISPLAY, NETWORKING, HTTP, GPIO
  src/main.c              # boot, work / timer, LED, button
  src/sensors.c           # LPS22HH + ISL29035 + RTC → one reading
  src/display.c           # JHD1313
  src/net.c               # HTTP JSON
```

A new `env-node` snippet (same shape as `i2c-shell`, fewer chips) enables
those four I²C parts. Manifest line pairs it with `virtio-i2c`, `virtio-gpio`,
and `net`. One A53 ELF plus the usual `_trace` twin. No staged images.

Keep the firmware ordinary Zephyr. Sensing uses the **RTIO** path
(`sensor_read_async_mempool`, completion queue, `sensor_get_decoder`), not
`sensor_sample_fetch` / `sensor_channel_get`. Display, RTC, GPIO, and HTTP
stay on their stock APIs. Nothing in the guest knows it is being toured.

## Teaching model

Two kinds of lesson, one outline.

**Live step** (what tours already are). `at:` stops the guest. The card can
`watch:`, `highlight:`, `dts:`, `panel:`, `threads:`, `objects:`. The learner
sees the call, the pin, the dock row.

**Desk step** (new). No `at:`. The card shows a shipped file that is not
executing: `CMakeLists.txt`, `prj.conf`, an overlay. `highlight:` still
points at the interesting lines. The guest stays where it is (frozen at reset
before the first live step; paused on the previous live step if a desk step
lands in the middle). Continue goes to the next card. Nothing pretends a
rebuild happened.

Desk steps are how we honor "show how to add a source file to CMakeLists"
without lying. The file is real. The running image already contains it. The
prose says that in one sentence: this is the line that pulled `sensors.c`
into the image you are running.

```markdown
## sensors.c is a second source file

```tour
file: CMakeLists.txt
highlight: /sensors.c/
```

`target_sources` is how an application adds a `.c` file. This line is why
`sensors.c` is in the image. The page does not rebuild Zephyr; the binary
you booted already includes it.
```

`at:` becomes optional. A step must have `at:` or `file:` (or `dts:` alone
for a tree-only card). The existing test that requires an anchor is updated
to require one of those.

### What the card may show on a desk step

| Allowed | Not allowed |
| --- | --- |
| `file:` + `highlight:` | `watch:`, `memory:`, `registers:`, `threads:`, `objects:` (nothing is stopped) |
| `dts:` (the running tree is already on the page) | `panel:` is fine: reveal the row the next live step will use |
| Prose, outline, Continue | Planting a breakpoint |

Ship `CMakeLists.txt`, `prj.conf`, and the snippet overlay next to the
sample sources when the tour asks for them. Widen the copy in
`tools/build-zephyr-image.sh` from "c/h in `src/`" to those named build
files as well. The ELF stays untouched.

## Fourteen lessons

Working title: **Environmental node**. About 14 steps, in four chapters.
Titles are for the outline; the tour prose is written later and needs a
human read-through ([copywriting skill](../.cursor/skills/copywriting/SKILL.md)).

### Chapter 1: What you are running

1. **Meet the node** (desk). What this station does. Point at the device
   dock: sensors, RTC, text display, Network. Invite the learner to move a
   slider after the tour; do not make them wait until the end to touch
   anything.
2. **The application is more than `main.c`** (desk, `CMakeLists.txt`).
   `find_package(Zephyr)`, `project()`, `target_sources`. One sentence on
   why a second `.c` file is listed here.
3. **Hardware is named in devicetree** (desk or live on
   `device_is_ready`, `dts:` on the LPS22HH node). Overlay vs board.
   Devicetree describes the bus and the parts; Kconfig selects the software
   that talks to them.

### Chapter 2: Sensing with RTIO

A node that reads two chips is why this curriculum exists. The stock
LPS22HH and ISL29035 samples each call `sensor_sample_fetch` then
`sensor_channel_get` on one device. That is **fetch and get**. Zephyr's
newer path is **read and decode** on top of [RTIO](https://docs.zephyrproject.org/latest/services/rtio/index.html):
submit a read for every sensor from one thread, wait on completion
events, decode the buffers.

That is the sensing chapter. Fetch and get stays in the short LPS22HH
tour if we write one. The node teaches the API you would use when the
station has more than one chip.

4. **An iodev per sensor** (live or desk, `sensors.c`).
   `SENSOR_DT_READ_IODEV` names the LPS22HH and the ISL29035. 
   `RTIO_DEFINE_WITH_MEMPOOL` is the submission and completion queues
   plus the buffers. Two devices, one context.
5. **Submit both reads** (live). `sensor_read_async_mempool` for each
   iodev. The thread does not block on the first chip before starting
   the second. Reveal the sensor rows. The I²C row can show both
   addresses.
6. **Completions and decode** (live). `rtio_cqe_consume_block`, then
   `sensor_get_decoder` / `sensor_decode` into q31 values. A completion
   is not a callback. The same thread that submitted the reads picks
   them up.
7. **Time belongs on the reading** (live, PCF8523). `rtc_get_time` on
   the decoded sample. Reveal the RTC row. A sample without a clock is
   a poll; a sample with a clock is a record.

**Driver risk.** Read and decode needs a `sensor_submit` implementation
on the chip and, for the full benefit, an RTIO-capable bus. LPS22HH and
ISL29035 are still fetch-and-get drivers today. Phase 3 of the app
should try `CONFIG_SENSOR_ASYNC_API` against these parts. If submit is
missing, the firmware falls back to fetch and get for that chip, and
lessons 4 to 6 still show the RTIO loop as the shape of the source we
want. Do not pick different silicon just to get a cleaner submit path.
Do not add RTIO to virtio-i2c only to make this curriculum compile.

### Chapter 3: Show it, serve it

8. **Write the display** (live, `display.c`, JHD1313).
   `auxdisplay_write`. Reveal the text display. The two lines are the
   latest reading, not "Hello World."
9. **LED means a fresh sample** (live, GPIO). `gpio_pin_toggle_dt` or
   `led_on` around the sample path. The Blinky vocabulary, now a status
   bit.
10. **A press demands a sample** (live, `gpio-keys` / input callback).
    Same idea as the Button tour, wired to `k_work_submit` instead of only
    a printk. Continue, then press SW0.
11. **The LAN gets JSON** (live, `net.c`). HTTP handler returns the latest
    reading. Reveal Network. The card tells the learner to fetch
    `http://192.0.2.1/` from that row.

### Chapter 4: How the image was configured, and what is next

12. **Kconfig selected the subsystems** (desk, `prj.conf`).
    `CONFIG_SENSOR`, `CONFIG_RTC`, `CONFIG_AUXDISPLAY`, `CONFIG_NETWORKING`.
    One line: Kconfig is which software is compiled in; the overlay is
    which parts are present.
13. **The whole loop** (live, synthesis). Stop on the sampling function
    once everything has run. Threads, the dock, the terminal. No new API.
14. **What you would add next** (desk, no new file required). Logging to
    flash, a humidity part, sleeping on a fuel gauge. Point at the matching
    gallery samples (LittleFS, Fuel gauge) as optional next apps, not as
    the next lesson of this path.

Fourteen is the ceiling, not a quota. If a draft reads as two lessons
saying the same thing, fold them. Do not add a fifteenth to "use the
budget."

## Product surface

Keep the app picker. Add a **Learn** entry that is a path, not another
alphabetical row.

**Where.** A **Learn** tab on the existing gallery dialog, next to Apps.
Do not add a second top-bar picker. The gallery is already "what runs."
Learn is "what to run first, and in what order." The mockup in this
branch is that tab plus a named outline on the tour card.

**What a curriculum card shows.** Title, one line of stakes ("Read the
air, stamp it, show it, serve it"), step count. Opening it boots
`env_node` on the current board (A53) and starts the tour. No subtitle
under every step in the picker; the outline lives on the tour card once
the path has started.

**Outline.** Fourteen dots are not enough. Replace (or supplement) the
dot strip with a named list: chapter headings, step titles, seen / current
/ locked. Clicking a seen step still revisits the card, same as today.
Keep the strip only if the named list is one click away; do not show both
at full size.

**Gallery row.** `env_node` also appears in the flat list, with the
existing guided badge, so someone browsing sensors can still find it.
Learn is the path; the row is the catalog entry.

**Short tours stay.** Blinky / Button / Philosophers remain "this sample
explains itself." They are not lessons 1 to 3 of the node. The last
lesson may *point* at them. A later phase can offer them as optional
prerequisites ("new to GPIO? take Blinky first") without making them
required hops.

## Engine and packaging (when we build this)

Small, local changes. No new guest-side annotation, no Kconfig in the
node "for the tour."

| Change | Where |
| --- | --- |
| Optional `at:`; new `file:` for desk steps | `src/tours/parse.ts`, tests |
| Desk-step runtime: show card, do not plant | `src/tours/store.ts` |
| Named outline for long tours | `src/components/tour/TourOutline.tsx` |
| Learn tab / pinned curriculum | `src/components/SampleGallery.tsx` |
| Front matter flag, e.g. `curriculum: Environmental node` | `tours/env_node.tour.md`, `src/tours/catalog.ts` |
| Copy CMake / Kconfig / overlay when a tour names them | `tools/build-zephyr-image.sh` |
| App, snippet, manifest, `boards.ts` | `zephyr-module/apps/env_node/`, `snippets/env-node/`, `tools/samples.manifest` |
| Authoring tests: desk steps need `file:` or `dts:`, not `at:` | `src/tours/guided.test.ts` |

Mock backend: desk steps already work (no machine). Live steps keep the
current timer walk. Enough to draft the tour without an emulator build.

Image cost: one new A53 ELF and its `_trace` twin. Not twelve.

## What we are not doing

- Replacing the gallery with a course catalog.
- Rebuilding Zephyr in the browser, or simulating a rebuild with `#ifdef`
  stages in one binary.
- Shipping a staged ELF per lesson.
- Adding BME280 / humidity only to make the node "complete."
- A 14-step tour of a stock single-chip sample.
- Teaching QEMU, virtio, or the image tarball in the lesson prose. Point
  maintainers at `docs/`; learners stay on the sensor, the thread, the
  dock row.
- Putting tour ids or `SAMPLE_ONCE()` back into the firmware.

## Phases

Build in this order so each phase is usable without the next.

1. **This plan**, reviewed. Especially the teaching model (complete app +
   desk steps) and the bill of materials.
2. **Desk-step format** (`file:`, optional `at:`), source packaging, named
   outline. Can land behind the existing short tours with no new app.
3. **`env_node` app** + snippet + gallery row. The node runs without a
   tour: LCD updates, JSON serves, sliders work.
4. **The 14-step tour** (`tours/env_node.tour.md`). Substantial new
   learner copy: flag the PR for a human read-through. Do not treat
   silence as approval.
5. **Learn tab** so the path is findable without hunting the gallery.
6. **Later, optional.** RISC-V twin. "New to GPIO?" links into Blinky /
   Button. A second curriculum (only if the first one is used). Humidity
   if we ever model the part.

Phase 3 before phase 4 on purpose: a node that runs is easier to tour
than a tour waiting on an app. Phase 2 can proceed in parallel with 3.

## Open questions

These are the only product calls that should block phase 2.

1. **HTTP server vs printk-only v1.** Server is the better "node" (you
   fetch JSON from Network). It is also the heaviest subsystem. If the
   first draft of `net.c` fights the lesson count, drop lesson 11 and the
   net snippet, and point at the HTTP Server sample from lesson 14.
2. **Where the RTIO consume loop runs.** A dedicated sampling thread
   gives a thread-list card that is not `main`. `k_work_delayable` stays
   shorter. Prefer the thread if lessons 5 to 6 need `threads: yes`.
3. **Learn tab vs pinned block.** The mockup ships a Learn tab on the
   gallery dialog. Keep it if a second curriculum appears; collapse to a
   pinned block only if the tab feels empty with one card.
4. **RTIO on these two drivers.** If phase 3 cannot call
   `sensor_read_async_mempool` on LPS22HH / ISL29035, do we still write
   the source as RTIO (and `#else` fetch and get), or do we teach fetch
   and get in the live steps and keep RTIO as a desk excerpt? Prefer the
   first so the file the learner sees matches the lesson titles.

Not open: live rebuilds, staged ELFs, humidity-as-blocker, replacing the
gallery.
