# Terminology

Use these spellings and senses everywhere learner-facing copy appears. Prefer the **Preferred** column; never invent a synonym for an existing Preferred term.

## Product and UI

| Preferred | Meaning | Avoid |
| --- | --- | --- |
| Zephyr in the Browser | This product / site | "the simulator product", "ZitB", "browser Zephyr" as a product name |
| page | The running web app the learner uses | "the frontend", "the SPA" |
| board | The emulated machine chosen in the top bar | "machine model", "target" (in UI copy); do not capitalize in prose |
| app | The program / image chosen in the top bar | "firmware binary", "ELF" (unless dropping a file); do not capitalize in prose |
| sample | A packaged Zephyr sample the app runs | "demo", "example app" when you mean a Zephyr sample |
| device dock | The sidebar of peripherals and instruments | "panel stack", "sidebar of widgets", "device panel" |
| peripheral | A device row in the dock (sensor, GPIO, …) | "gadget", "widget" |
| instrument | Machine-level dock rows (Simulation, Trace, Debug) | calling instruments "peripherals" |
| guided tour / tour | Markdown-driven stop-and-explain walkthrough | "walkthrough", "tutorial mode", "CodeTour" |
| guest | The firmware / Zephyr image running in the emulator | "VM", "container"; do not say "emulator" when you mean the software inside it |
| terminal | The serial console on the page | "UART panel" in UI chrome |
| Trace | The CTF timeline instrument | "CTF panel" in learner UI (say Trace; mention CTF when teaching tracing) |
| Debug | The debugger instrument | "GDB panel" in learner UI labels |
| Settings | Top-bar gear for the desktop bridge URL | burying a second URL field in Trace or Network |
| desktop bridge | The small desktop daemon (Settings) that can carry Live board tracing, Bridge network, and Debug | "probe bridge", "uber bridge", "probe gateway" |
| Live board | Trace section that streams traces from a real board via the desktop bridge | "hardware mode", "real target" as the section name |
| Bridge network | Network mode that sends guest frames through the desktop bridge (or a net-only gateway URL) | "gateway mode" in learner UI labels |
| Uplink | Network disclosure that chooses Simulated LAN vs Bridge network | calling the mode itself "Uplink" |

**Capitalization:** In prose write board, app, device dock, terminal. Keep Trace / Debug / Simulation as the dock labels. Title-case a word only when matching an on-screen control label the learner should click.

**Guest vs sample:** Prefer **guest** for the running session (boot, pause, resume, bus traffic, peripherals appearing). Prefer **sample** / **app** / **Zephyr** when teaching the software itself. "Emulator" is fine for the QEMU tool in maintainer docs; in learner copy, point at the guest or the sample instead.

## Zephyr concepts (learner-facing)

Align with upstream Zephyr wording. Keep these stable:

| Preferred | Use for | Notes |
| --- | --- | --- |
| Zephyr / Zephyr RTOS | The OS itself | "Zephyr" is enough after first mention on a surface |
| board | Hardware (or emulated hardware) you build for | Same word as the UI board picker; lowercase in prose |
| application | User code + config that produces an image | In this UI the picker says app |
| application image / image | The binary that boots | Prefer "image" once "application image" is clear |
| sample | Upstream (or packaged) example under `samples/` | |
| kernel | Zephyr kernel services | Not "the OS core" |
| thread | Zephyr thread | Not "task" unless quoting an API that says task |
| ISR / interrupt handler | Interrupt context | Prefer "interrupt handler" on first use, then ISR is fine |
| driver | Device driver bound to hardware | |
| API | Public Zephyr C API the sample calls | |
| devicetree | Hardware description | Always one word, lowercase d in prose ("devicetree"); capitalize only in headings if needed |
| Kconfig | Software feature configuration | Not "kernel config" when you mean Kconfig |
| west | Zephyr's meta-tool | Rarely needed in learner UI; fine in getting-started blurbs |
| subsystem | A distinct Zephyr service area (networking, …) | |

**Devicetree vs Kconfig (one-liner for learners):**
devicetree describes hardware and its boot-time setup; Kconfig selects which software support is built in.

## Emulator internals (usually out of scope)

These are fine in `docs/` and code comments. In learner copy, mention them only when the learner must act on them:

| Term | Learner-facing guidance |
| --- | --- |
| QEMU / WebAssembly / Emscripten | One short phrase is enough ("running in your browser"); no stack tour |
| virtio / bridge | Prefer what the learner sees ("the LED in the dock") |
| Cortex-M3 / Cortex-A53 | Name the board the UI shows; do not explain why A53 is the engineering focus |
| CTF tracing | Teach as "tracing" / Trace unless the sample is about CTF |
| mock backend | OK when explaining first-run without a QEMU build |

## Style tips that keep terms stable

- When telling someone where to click, match the control's visible label (board, app, device dock, Trace, Debug) without turning every mention into Title Case.
- When teaching a Zephyr API, use the real symbol (`k_msleep()`, `gpio_pin_toggle_dt()`). Do not paraphrase the function name.
- Prefer "stock Zephyr" / "upstream sample" when stressing that the firmware is unchanged by a tour.
- Do not alternate "board" / "machine" / "target" / "platform" in the same piece for the same thing.
- Avoid em dashes; prefer a period or a short second sentence.
