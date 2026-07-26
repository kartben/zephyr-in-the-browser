# Sample coach macros — plan

Teaching overlays driven from **macros in guest sample code**: explanations,
dock highlights, and optional pauses that the browser UI turns into popups and
guided attention. This is a design plan, not an implementation.

Today the lab already teaches by pairing a sample with `primaryPanels`,
footer shell hints (“In the guest: …”), register maps, and mirrored docs.
What it does **not** have is a way for the *running sample* to narrate itself
at the right moment — “I just claimed this GPIO”, “watch the I²C write that
sets ODR”, “click SW0 now”. That is the gap this plan closes.

## Goals

- Let didactic samples (or thin wrappers around upstream samples) emit
  structured **coach events** from C with a small macro API.
- Have the page react: fancy but restrained popups, dock-row reveal, optional
  auto-pause until the learner continues, and terminal/source callouts.
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

## Design sketch

```
  sample C  --COACH_* macros-->  coach transport  -->  page coach runtime
                                                          |
                    +------------ popup / toast ----------+
                    +------------ revealDockRow ----------+
                    +------------ pause / continue -------+
                    +------------ optional source pin ----+
```

### Macro API (guest)

A tiny Zephyr module header, e.g. `zephyr-module/include/browser_coach.h`,
gated by `CONFIG_BROWSER_COACH`. Macros compile to nothing when disabled.

```c
/* Fire-and-forget explanation near the UI focus. */
COACH_EXPLAIN("gpio", "LED0 is GPIO pin 4 on virtio_gpio0 — watch the dock.");

/* Point at a dock row / panel (keys match DeviceNode / PanelKind ids). */
COACH_REVEAL("led:led0");
COACH_REVEAL_PANEL("gpio");

/* Soft or hard pause: show popup, wait for Continue (see Pause below). */
COACH_PAUSE("Click SW0 in the Keys row, then Continue.");

/* Hint that belongs next to a shell command the learner should type. */
COACH_SHELL("sensor get lsm6dso@6a");

/* Optional: pin a source anchor for the docs/gallery side (file:line or tag). */
COACH_PIN("main.c:42", "sensor_attr_set sets the ODR the dock will reflect.");
```

Implementation shape:

| Piece | Role |
| --- | --- |
| `COACH_*` macros | Encode a small tagged message (id, kind, payload string) |
| `browser_coach_emit(...)` | Backend that actually sends bytes / waits for ACK |
| Kconfig `BROWSER_COACH` | Default `n` for production images; `y` on “tour” builds |

Payloads stay short (≈120–200 bytes). Rich markdown stays out of the guest;
the page can map stable `id`s to longer copy if needed later.

### Transport — phased

**Phase A — console OSC markers (recommended first cut).**  
Emit an OSC-style sequence on the console (filtered out of the visible
xterm stream), e.g.:

```text
ESC ] 787 ; <json-or-tlv> BEL
```

The PTY backend already owns guest→host bytes (`src/backends/`). A thin
parser strips coach frames before they reach xterm and dispatches to a
`coachStore`. Works on every board that has a serial console — including
Cortex-M3 — with **no QEMU patch**.

Risks: accidental binary in logs if filtering fails; need to escape/length-
prefix payloads; pause-ACK needs a reverse path (host→guest). For pause ACK
in Phase A, either:

1. **Soft pause only** — UI blocks interaction overlay while the vCPU keeps
   running (honest about not freezing time), or
2. **Guest spin** — `COACH_PAUSE` polls a second console escape / shell
   injection / semihosting peek until the page writes “continue” (clunky but
   workable for demos).

**Phase B — dedicated coach channel.**  
Once Phase A proves the UX, promote to a proper bridge:

- Prefer **virtio-browser** named `coach` (TypeScript model, no new QEMU C
  beyond the existing generic device), or
- A tiny **MMIO mailbox** on the host-gpio shape if M3 must hard-pause without
  virtio.

Phase B gives clean request/ACK pause and does not share the serial stream.

### Host runtime & UI

New pieces (names indicative):

| Piece | Responsibility |
| --- | --- |
| `src/coach/parse.ts` | Extract coach frames from PTY bytes |
| `src/coach/store.ts` | Queue of active hints; dismiss / continue |
| `src/components/CoachOverlay.tsx` | Stage-level popup (one composition: title + short body + CTA) |
| Hooks into `revealDockRow` / `primaryPanels` | Attention blink already exists |

UI rules that fit this repo’s taste:

- **One coach card at a time** (queue the rest); never a dashboard of tips.
- Popups live on the **stage** (near the terminal), not as floating stickers
  on peripheral media.
- Prefer **reveal + short sentence** over long essays; deep content stays in
  mirrored sample docs.
- Motion: reuse dock reveal blink; one enter/exit on the coach card.

### Pause semantics

| Mode | Behavior | When to use |
| --- | --- | --- |
| `soft` | Overlay + Continue; guest keeps running | Blinky, network, anything time-sensitive where freeze lies |
| `hard` | Guest blocks in `COACH_PAUSE` until ACK | Button / shell “do this now” beats where causality matters |
| `auto` | Timed toast, no Continue | Low-stakes explain near a printk |

v1 can ship `explain` + `reveal` + `soft` pause only; add `hard` with Phase B.

### How annotations land on samples

Upstream paths in `tools/samples.manifest` stay stock. Coach belongs in
**this** tree:

1. **Header-only annotations** in `zephyr-module/apps/*` (we already own
   `accelerometer_chart`).
2. **Thin wrapper apps** under `zephyr-module/apps/` that `#include` or
   duplicate a short `main` around the same APIs the upstream sample uses —
   only for the few “tour” demos worth scripting.
3. **Optional conf fragment** `zephyr-module/conf/coach.conf` turned on by a
   manifest snippet (`coach`) so tour images are explicit, not accidental.

Do **not** require editing Zephyr’s `samples/` tree inside the west workspace
for day-to-day builds.

---

## Applying coach to the most didactic samples

Priority is payoff per annotation, not coverage. Start with samples that
already have a clear dock story (`primaryPanels`) and a single “aha”.

### 1. `blinky` — GPIO output heartbeat

**Teaches:** a thread toggles a GPIO LED; the dock is the hardware.

Suggested beats:

| When (in guest) | Event | UI |
| --- | --- | --- |
| After `gpio_is_ready_dt` | `EXPLAIN` + `REVEAL_PANEL(led/gpio)` | “LED0 is the pin the sample toggles.” |
| First toggle | `EXPLAIN` (auto) | “Each `gpio_pin_toggle` flips the dock LED.” |
| Loop settled | `SHELL` optional | Only if shell is present; else skip |

**Why first:** shortest path end-to-end; validates parse → overlay → reveal
with almost no timing sensitivity. Soft pause only (blink must keep moving).

### 2. `basic_button` — input → output

**Teaches:** `gpio-keys` IRQ/path lights an LED when SW0 is pressed.

Suggested beats:

| When | Event | UI |
| --- | --- | --- |
| Init OK | `REVEAL` keys + led | Expand Keys and LED rows |
| Before wait / poll loop | `PAUSE` (hard if available) | “Press SW0 in the Keys row.” |
| On first edge handled | `EXPLAIN` | “The guest saw the interrupt / callback; LED follows.” |

**Why high value:** this is the first sample that needs a *learner action*.
It justifies pause-ACK more than blinky does.

### 3. `shell` — interactive lab bench

**Teaches:** the shell is the interface to bridges (`gpio`, `sensor`, `i2c`,
`hostaudio`, …).

Here macros in a stock shell module are awkward (upstream, long-lived). Prefer
a **host-side playbook** keyed by sample id, plus a few guest emits from a
small `coach` shell command registered only when `CONFIG_BROWSER_COACH=y`:

```text
uart:~$ coach demo sensors
```

Beats driven from the page when `app=shell` boots:

1. Explain dock layout (I²C vs GPIO vs audio depending on board).
2. `SHELL` chips: suggest `i2c scan`, `sensor get`, `gpio get`.
3. Optional guest `COACH_EXPLAIN` inside a module init if we add a tiny
   `browser_coach` shell subcommand that samples can call.

**Why:** highest dwell time; coaching is “try this command” rather than
narrating a fixed `main`.

### 4. `lsm6dso` (and kin: `lps22hh`, `ina219`, `isl29035`)

**Teaches:** stock sensor driver + `sensor_attr_set` / fetch over I²C; dock
sliders are the physical world.

Suggested beats (wrapper or patched tour app):

| When | Event | UI |
| --- | --- | --- |
| Before first `sensor_sample_fetch` | `REVEAL` sensor + i2c | Show chip row + bus |
| After `sensor_attr_set` (ODR) | `PIN` + `EXPLAIN` | “ODR write just crossed the bus — open the I²C trace / Registers.” |
| Loop | rare `auto` explain | Don’t spam every sample; at most once |

**Why:** best hardware-lab story in the catalog; ties guest API to the I²C
trace and register map that already exist.

### 5. `accel_chart` — owned sample

**Teaches:** browser tilt → simulated IMU → LVGL chart.

This is the **ideal first annotated codebase**: it already lives under
`zephyr-module/apps/accelerometer_chart/`. Sprinkle `COACH_*` at:

- display/sensor ready,
- first chart update,
- when follow-tilt is meaningful (“enable Follow on the ADXL/LSM row”).

No upstream conflict; proves the full guest macro path before wrappers.

### 6. Networking suite (`dhcp`, `http_get`, `echo_server`, …)

**Teaches:** the page *is* the LAN.

Beats:

| When | Event | UI |
| --- | --- | --- |
| iface up / DHCP bound | `REVEAL_PANEL(net)` + `EXPLAIN` | “Addresses appear in the Network panel.” |
| first TCP connect | `EXPLAIN` | Point at capture / throughput |
| server ready | `SHELL` or copy-paste host hint | e.g. what the in-page client will do |

Soft pause only — freezing the guest mid-TCP is hostile. Prefer explain +
reveal timed to printk milestones already in those samples.

### 7. `tracing`

**Teaches:** CTF stream → Gantt on the stage.

One or two explains at boot (“semihosting is writing `tracing.bin`; the Trace
panel follows it”) plus reveal of the trace overlay. Avoid pauses that stop
event production.

### 8. Display / touch / LVGL (`display`, `touch`, `lvgl_music`)

**Teaches:** framebuffer + virtio-input tablet.

Coach should stay off the framebuffer: stage popup near the terminal, and
`REVEAL`/focus the floating display window rather than overlaying badges on
pixels. Beats: “drag on the display — the guest sees a virtio tablet.”

### Explicitly lower priority

| Sample | Reason to wait |
| --- | --- |
| `hello_world` | Too little to narrate; gallery blurb is enough |
| `philosophers` | Timing already fragile on M3 TCI; pauses make it worse |
| `hsm` | Shell-driven; host playbook like `shell` is enough |
| EEPROM / SPI flash / RTC | Great labs, but second wave after sensors + GPIO |

---

## Rollout plan

### Milestone 0 — contract only

- This document + a sketched `browser_coach.h` API and OSC frame format.
- Vitest fixtures for the parser (`explain` / `reveal` / `pause` frames).
- No guest image rebuild required.

### Milestone 1 — host UX + soft coach

- PTY filter + `CoachOverlay` + queue.
- Host-side playbooks for `shell` and `blinky` (even with zero guest macros)
  to validate UX against live images.
- Wire `REVEAL` to existing `revealDockRow`.

### Milestone 2 — guest macros on owned code

- `CONFIG_BROWSER_COACH` + header in `zephyr-module`.
- Annotate `accelerometer_chart`.
- Optional `coach` snippet / conf for tour builds in `samples.manifest`.

### Milestone 3 — tour wrappers for GPIO + IMU

- Thin apps or overlay mains for `blinky`, `basic_button`, `lsm6dso`.
- Soft pause everywhere; hard pause prototype on A53 virtio if needed.

### Milestone 4 — hard pause channel (optional)

- virtio-browser `coach` device or MMIO mailbox + ACK.
- Switch `COACH_PAUSE` to blocking where demos need it (`basic_button`).

---

## Concrete first annotations (cheat sheet)

If implementing tomorrow, do these three only:

1. **`accel_chart`** — 3× `COACH_EXPLAIN` / `COACH_REVEAL` in the owned app.  
2. **`blinky`** — host playbook on boot + one guest explain after GPIO ready
   (wrapper).  
3. **`basic_button`** — soft (then hard) pause “Press SW0” + reveal Keys/LED.

That set exercises reveal, explain, learner action, and owned vs wrapper
packaging without touching the network or tracing stacks.

---

## Open questions

1. **Upstream posture:** keep coach forever out-of-tree, or eventually propose
   a Zephyr “sample annotation” convention? (Assume out-of-tree until proven.)
2. **Copy length:** guest strings vs page-side dictionary keyed by `id`?
   Start with guest strings; move long copy to the page if i18n/docs matter.
3. **Hard pause on M3:** worth an MMIO mailbox, or accept soft-only on M3?
4. **Docs widget:** should mirrored sample docs auto-start the coach playbook
   when “Run in simulator” opens?
5. **Noise control:** global mute, per-sample default, and “don’t show again”
   for returning users?

## Related

- Sample catalog: [`src/boards.ts`](../src/boards.ts), [`tools/samples.manifest`](../tools/samples.manifest)
- Dock reveal: [`src/lib/dockReveal.ts`](../src/lib/dockReveal.ts)
- Mirrored docs + Run in simulator: [`sample-docs.md`](sample-docs.md)
- Bridge shapes / cost of new devices: [`next-drivers.md`](next-drivers.md), [`virtio-bridge.md`](virtio-bridge.md)
