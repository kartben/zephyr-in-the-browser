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
| emulator | The running QEMU session (and the Zephyr image inside it, in learner copy) | "guest", "VM", "container" |
| terminal | The serial console on the page | "UART panel" in UI chrome |
| Trace | The CTF timeline instrument | "CTF panel" in learner UI (say Trace; mention CTF when teaching tracing) |
| Debug | The debugger instrument | "GDB panel" in learner UI labels |

**Capitalization:** In prose write board, app, device dock, terminal. Keep Trace / Debug / Simulation as the dock labels. Title-case a word only when matching an on-screen control label the learner should click.

**Emulator vs firmware:** Prefer **emulator** when pointing at the running session (boot, pause, resume, peripherals appearing). Prefer **sample** / **app** / **Zephyr** when teaching the software itself. Avoid **guest** in learner copy.

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
| QEMU / WebAssembly / Emscripten | "emulator" is enough for most learners; one short phrase if needed ("running in your browser") |
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
