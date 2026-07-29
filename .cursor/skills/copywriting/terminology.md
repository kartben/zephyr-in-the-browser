# Terminology

Use these spellings and senses everywhere learner-facing copy appears. Prefer the **Preferred** column; never invent a synonym for an existing Preferred term.

## Product and UI

| Preferred | Meaning | Avoid |
| --- | --- | --- |
| Zephyr in the Browser | This product / site | "the simulator product", "ZitB", "browser Zephyr" as a product name |
| page | The running web app the learner uses | "the frontend", "the SPA" |
| Board | The emulated machine chosen in the top bar | "machine model", "target" (in UI copy) |
| App | The program / image chosen in the top bar | "firmware binary", "ELF" (unless dropping a file) |
| sample | A packaged Zephyr sample the App runs | "demo", "example app" when you mean a Zephyr sample |
| device dock | The sidebar of peripherals and instruments | "panel stack", "sidebar of widgets", "device panel" |
| peripheral | A device row in the dock (sensor, GPIO, …) | "gadget", "widget" |
| instrument | Machine-level dock rows (Simulation, Trace, Debug) | calling instruments "peripherals" |
| guided tour / tour | Markdown-driven stop-and-explain walkthrough | "walkthrough", "tutorial mode", "CodeTour" |
| guest | The firmware running inside the emulator | "VM", "container" |
| terminal | The serial console on the page | "UART panel" in UI chrome |
| Trace | The CTF timeline instrument | "CTF panel" in learner UI (say Trace; mention CTF when teaching tracing) |
| Debug | The debugger instrument | "GDB panel" in learner UI labels |

## Zephyr concepts (learner-facing)

Align with upstream Zephyr wording. Keep these stable:

| Preferred | Use for | Notes |
| --- | --- | --- |
| Zephyr / Zephyr RTOS | The OS itself | "Zephyr" is enough after first mention on a surface |
| board | Hardware (or emulated hardware) you build for | Distinct from UI **Board** only by context; same idea |
| application | User code + config that produces an image | In this UI the picker says **App** |
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
| Cortex-M3 / Cortex-A53 | Name the Board the UI shows; do not explain why A53 is the engineering focus |
| CTF tracing | Teach as "tracing" / Trace unless the sample is about CTF |
| mock backend | OK when explaining first-run without a QEMU build |

## Style tips that keep terms stable

- Reuse the UI label exactly when telling someone where to click (**Board**, **App**, **device dock**, **Trace**, **Debug**).
- When teaching a Zephyr API, use the real symbol (`k_msleep()`, `gpio_pin_toggle_dt()`) — do not paraphrase the function name.
- Prefer "stock Zephyr" / "upstream sample" when stressing that the firmware is unchanged by a tour.
- Do not alternate "board" / "machine" / "target" / "platform" in the same piece for the same thing.
