# What to add next

Notes on the next peripherals to bring into the browser, ranked by payoff per
unit of effort rather than by how exciting the word sounds. The through-line:
every device we have today is a **bridge** between a browser API and a Zephyr
driver, and each one follows one of three shapes already proven in the tree.
Picking the next driver is mostly about which shape it reuses and whether the
guest-side driver already exists upstream.

## The three bridge shapes we already have

Everything currently wired is one of these. New drivers should reuse a shape,
not invent a fourth unless they must.

1. **Host → guest, shared memory** — `qemu,host-sensor`.
   JS calls `_qemu_host_sensor_set(channel, value)`, which writes into memory the
   guest reads over MMIO. No proxying, no JS on the guest's read path. See
   [`src/hostSensor.ts`](../src/hostSensor.ts),
   [`zephyr-module/drivers/qemu_host_sensor.c`](../zephyr-module/drivers/qemu_host_sensor.c),
   and `tools/qemu-patches/0001-hw-misc-add-qemu-host-sensor.patch`.
   *Cheapest shape.* Good for anything that is "a value the browser knows and the
   guest reads."

2. **Guest → host, exported framebuffer** — `qemu,ramfb`.
   The guest writes pixels; QEMU already maps that buffer, so the patch just
   exposes the pointer/stride and JS paints a canvas. See
   [`src/hostDisplay.ts`](../src/hostDisplay.ts) and
   `tools/qemu-jit-patches/0002-hw-display-expose-ramfb-to-browser.patch`.
   Good for anything that is "a buffer the guest fills and the browser renders."

3. **Bidirectional, char device** — browser GNSS UART.
   A QEMU chardev backed by browser data feeds bytes into a second PL011; the
   guest runs Zephyr's stock NMEA driver over it. See
   [`src/hostGnss.ts`](../src/hostGnss.ts) and
   `tools/qemu-jit-patches/0003-hw-char-add-browser-gnss-uart.patch`.
   Good for anything stream-shaped.

Note what all three have in common: **each required a QEMU C patch.** That is the
real cost of a new device here, not the JS panel. Which is exactly why virtio is
interesting — see below.

## Ranking

### 1. GPIO — buttons and LEDs — ✅ done

**Implemented** as the `qemu,host-gpio` device on the Cortex-M3 shell image:
a custom MMIO controller modeled on `qemu-host-sensor` (patch
`tools/qemu-patches/0005-hw-misc-add-qemu-host-gpio.patch`), a Zephyr GPIO
controller driver (`zephyr-module/drivers/qemu_host_gpio.c`), and a browser
panel with clickable buttons and live LED indicators
(`src/components/GpioPanel.tsx`, bridge in `src/hostGpio.ts`). Reachable in the
guest with `gpio get host_gpio <pin>` / `gpio set host_gpio <pin> <0|1>`.
Interrupts are deliberately out of the first cut — `pin_interrupt_configure`
reports `-ENOTSUP`, so it pairs with the shell rather than the IRQ-driven button
sample; wiring a GPIO IRQ line to the Stellaris NVIC is the obvious follow-up.

Original rationale, kept for the record —
the highest demo-value-per-effort item, and it reuses shapes we already have in
both directions:

- **Buttons (host → guest):** a press raises a guest interrupt. This is the
  host-sensor shape plus an IRQ line — JS sets a pin level, the device latches it
  and pulses the guest's interrupt controller.
- **LEDs (guest → host):** the guest drives an output pin, JS reads the level and
  lights a dot in a panel. This is the framebuffer-export shape shrunk to one bit.

Why it wins:

- **Interactive in a way sensors are not.** A clickable button and a blinking LED
  is the canonical "it's alive" embedded demo. Zephyr's `samples/basic/blinky`
  and `samples/basic/button` are stock and tiny.
- **Guest driver already exists.** Zephyr's GPIO subsystem and the `gpio-keys` /
  `gpio-leds` bindings are mature. On the M3 the Stellaris machine already models
  GPIO ports; on the a53 `virt` there is a PL061. We can either drive those or —
  more in keeping with the host-sensor precedent — add a small
  `qemu,host-gpio` MMIO device whose input levels JS sets and whose output levels
  JS reads. The bespoke route sidesteps any question of whether the stock board
  wires `gpio-keys`, and it is a ~single-file QEMU device modeled directly on
  `qemu_host_sensor.c`.
- **Both directions in one panel.** A row of toggle buttons and a row of LED
  indicators exercises host→guest *and* guest→host in one small piece of UI.

Scope for a first cut: 4 input pins (buttons) + 4 output pins (LEDs), one MMIO
device, one Kconfig-gated Zephyr driver, one `GpioPanel.tsx`, wire it into
`boards.ts` `peripherals`. Ship on the M3 shell image first since that board is
already the interactive one.

### 2. virtio — the strategic bet, and the answer to "what does this even mean"

**What virtio is, in this project's terms.** virtio is a *standard paravirtual
device bus*. Instead of a bespoke MMIO device + bespoke Zephyr driver + bespoke
QEMU patch (what all three of our current bridges are), the guest talks to a
generic virtio transport and negotiates queues with the host in a way both sides
already agree on. The a53 `virt` machine **already exposes virtio-mmio slots** —
they are sitting there unused today.

**Why it matters here specifically:** as of 2025–2026 Zephyr ships the
guest-side pieces that make this real:

- a **virtio-mmio transport** driver (the a53 `virt` slots are exactly this),
- a **virtio-pci** transport,
- **virtio-console/serial** — and notably it *auto-configures in QEMU* via CMake,
- **virtio-entropy** and **virtiofs**,
- **virtio-net**, and — since June 2026 — **virtio-input**.

That means a virtio device could become **the first peripheral that runs against
stock QEMU with no C patch of ours** — the transport is already in upstream QEMU
and the driver is already in Zephyr. That is a meaningful reduction in the
per-device cost that shapes 1–3 all pay.

#### How that bet turned out: two shipped, and the patch bill was not zero

**virtio-net shipped first**, quietly, as the Cortex-A53 Ethernet path: a stock
`virtio-net-device` on slot 0 against Zephyr's own driver. **virtio-input
shipped second**, as the display panel's touchscreen — a stock
`virtio-tablet-device` on slot 3 against Zephyr's upstream `virtio,input`
driver. So the transport is proven in qemu-wasm, twice, and neither needed a
line of guest-side code from us. The exploratory track below is *done*;
virtio-entropy and virtio-console would now be proving something already
proven.

The honest scorecard on the "no C patch of ours" promise is **half-kept, and
the half that failed is instructive**:

- The **device models** really are free. Both `virtio-net-device` and
  `virtio-tablet-device` were already compiled into our wasm binary before
  anyone asked for them, because `--without-default-features` prunes *host*
  features, not device models.
- What is *not* free is the **host side of the device**. QEMU still has to
  reach a real backend, and in a browser there is none. virtio-net needed
  `net/browser.c`, a whole netdev. virtio-input needed
  `hw/misc/qemu-browser-input.c` — much smaller, because it adds no device at
  all, just a frontend feeding `qemu_input_queue_abs`/`_btn` from a ring, the
  role SDL or GTK plays in a normal build.

The generalisation worth carrying forward: **virtio removes the guest-side
cost, never the host-side one.** A virtio device is cheap here exactly to the
degree that QEMU's existing backend for it already works headless. That is why
virtio-input cost ~200 lines and virtio-snd (`audio-feasibility.md`) would
still cost an audiodev — and it is the real reason to reach for virtio, rather
than the "no patch" framing this section started with.

#### virtio-gpu — vendored, guest-side proven, *not* a display speed-up

The driver exists but is not upstream, so a pristine copy is vendored at
[`zephyr-module/drivers/vendor/`](../zephyr-module/drivers/vendor/) (provenance
and the drift check live in `VENDOR.md` next to it). It is opt-in per build via
a module snippet, since the board otherwise stays on ramfb:

```console
west build -b qemu_cortex_a53 -S virtio-gpu <app> \
  -- -DZEPHYR_EXTRA_MODULES=<repo>/zephyr-module -DSHIELD=browser_bridge
```

The snippet ([`zephyr-module/snippets/virtio-gpu/`](../zephyr-module/snippets/virtio-gpu))
disables `ramfb0`, enables the `virtio_gpu0` node the `browser_bridge` shield
declares on virtio-mmio slot 1, and repoints `zephyr,display` and the touch
device at it. QEMU needs the matching device, sized to agree with devicetree:

```
-device virtio-gpu-device,bus=virtio-mmio-bus.1,xres=600,yres=400
```

Verified under native QEMU: the driver probes, logs `scanout 0 initialized at
600x400`, and `samples/drivers/display` runs against it. **No QEMU wasm build
carries it yet**, because seeing it in the browser needs a bridge patch
alongside `0002-hw-display-expose-ramfb-to-browser.patch` — the ramfb bridge
only publishes state `ramfb_setup()` populates, so under the snippet the Display
panel would stay blank. That patch is the remaining work, and it is the natural
place to also export a **flush event and damage rect**, which ramfb structurally
cannot provide.

**It will not make the display faster, and here is the measurement.** Guest time
per frame, 600×400 ARGB8888, native QEMU with the browser's own
`-icount shift=4`, via a bench that drives `display_write()` in the shapes LVGL
flushes in:

| per frame | ramfb | virtio-gpu | cacheable FB | ramfb, `-O2` |
| --- | ---: | ---: | ---: | ---: |
| full frame, 1 flush | 92.34 ms | 92.46 ms | 93.65 ms | **2.63 ms** |
| full frame, 16 flushes | 92.34 ms | 94.23 ms | 113.50 ms | 2.62 ms |
| 64×64 rect, 1 flush | 1.59 ms | 1.71 ms | 2.91 ms | **0.07 ms** |
| full frame, **copy only** | 92.34 ms | 92.36 ms | 92.36 ms | 2.62 ms |

Read the "copy only" row first: **the pixel copy is the entire cost**, and no
transport changes it. ramfb's is free — its "1 flush" and "copy only" numbers
match to the microsecond, because `ramfb_write()` is nothing but a `memcpy` and
QEMU maps that buffer directly. virtio-gpu can only add: ~118 µs per flush for
the fenced `TRANSFER_TO_HOST_2D` + `RESOURCE_FLUSH` round-trips (the 1-flush and
16-flush rows agree on that figure independently). Honouring `frame_incomplete`
matters — 16 flushes per frame costs 1.9 ms more than one.

The cacheable column closes a tempting side quest: both drivers map the
framebuffer `K_MEM_CACHE_NONE`, so a write-back mapping looks like free
bandwidth. It is not. QEMU's TCG does not model caches, so the copy does not get
faster, and the cache maintenance correctness then demands is pure loss.
(virtio-gpu *is* the only one of the two where such a mapping could ever be
correct, since it has an explicit flush point and ramfb has none — but there is
nothing to win.)

**The last column is where the real win turned out to be, and it is not a
display problem at all.** Zephyr defaults to `-Os`; on AArch64 that selects the
SDK's `space` multilib, in which picolibc compiles the hand-written `memcpy.S`
*out* — the archive member is empty — leaving only `memcpy-stub.c`, a byte loop
costing six instructions per byte. Every one is emulated. Switching to `-O2`
gets the 139-instruction LDP/STP memcpy and the copy that *was* the frame
becomes **35× cheaper**. That is now the default for every packaged image, in
the `browser_bridge` shield's `Kconfig.defconfig`; it costs ~24% ELF size.

With the copy down to 2.6 ms, **fewer bytes is no longer the interesting
lever** — RGB565 would now save ~1.3 ms/frame, not ~46 ms, so it is hard to
justify against the three coordinated changes it needs (an RGB565 path in the
display driver, `CONFIG_LV_COLOR_DEPTH=16`, and an RGB565 upload path in
[`src/display/renderers.ts`](../src/display/renderers.ts), whose shader and
`FOURCC_AR24` check both assume 32bpp; doing only some of them adds a conversion
and loses). What remains is LVGL's own rendering, which the copy was masking.

So the case for finishing virtio-gpu is *not* frame rate. It is that a flush
event would let the browser stop re-uploading unchanged frames: the render
worker currently uploads at a fixed 30 Hz while the guest produces roughly
4–10, so most texture uploads are redundant.

### 3. Audio — output first, and *not* via virtio — ✅ done

**Implemented** in both directions on both machines, behind Zephyr's standard
audio APIs (the fuller virtio-snd analysis lives in
[`audio-feasibility.md`](audio-feasibility.md)):

- **Out — `qemu,host-audio`, exposed as I2S.** A custom MMIO PCM ring, rate
  and channels guest-programmable (patches
  `tools/qemu-patches/0006-hw-misc-add-qemu-host-audio.patch` and
  `tools/qemu-jit-patches/0005-hw-misc-add-qemu-host-audio.patch`), driven by
  a transmit-only Zephyr **I2S driver**
  (`zephyr-module/drivers/qemu_host_audio.c`) so I2S applications work
  unmodified. The `hostaudio` shell commands (`beep`, `melody`) are written
  against the I2S API and demo it from the stock shell samples.
- **In — `qemu,host-mic`, exposed as DMIC.** The mirror-image device (patches
  `.../0007-...` and `.../0006-hw-misc-add-qemu-host-mic.patch`) behind a
  Zephyr **DMIC driver** (`zephyr-module/drivers/qemu_host_mic.c`), paced
  against real time and silence-filling when the page has no mic permission.
  The stock `samples/drivers/audio/dmic` runs against it — but only after a
  one-character fix: it passes a `uint32_t` where `dmic_read()` takes a
  `size_t *`, which corrupts the stack on 64-bit targets (crash verified on
  qemu_cortex_a53, fix verified too; candidate upstream patch). The packaged
  Cortex-A53 demo is therefore Zephyr's own `dmic` shell commands
  (`CONFIG_AUDIO_DMIC_SHELL`: `read`, `vu`, `dump`), which bind to this driver
  from the stock shell sample — `dmic vu dmic0` is a live level meter, and
  `dmic dump` base64-captures PCM for offline playback.
- **Browser** — one panel for both (`src/components/AudioPanel.tsx`; bridges
  `src/hostAudio.ts`, `src/hostMic.ts`): speaker enable click satisfies the
  autoplay policy, mic enable click the getUserMedia permission. Guest flow
  control never notices either switch — playback drains (and drops) while
  muted, and the DMIC driver reads silence while the mic is off. The shell
  commands bound writes by the ring's free space and never sleep, which is
  what keeps them usable on the TCI Cortex-M3.

Original rationale, kept for the record —
appealing, and doable, but bespoke. Because there is no virtio-snd driver in
Zephyr, this is not a stock path — it is a new bridge.

- **Output (guest → browser), the tractable direction:** the guest writes PCM
  into a ring buffer; JS reads it and plays it through the Web Audio API. This is
  the **framebuffer-export shape** with audio samples instead of pixels. A custom
  `qemu,host-audio` device exports the buffer pointer the way ramfb exports the
  framebuffer. On the guest side an I2S-style or custom PCM-out driver feeds it.
  Medium effort, self-contained, and "the board plays a tone / a WAV" is a decent
  demo.
- **Input (mic → guest):** `getUserMedia` → shared PCM buffer → guest reads, i.e.
  the **host-sensor shape** streamed. Needs mic permission; lower priority than
  output.

Verdict: worth doing after GPIO, before webcam. Keep it a bespoke host-PCM
bridge; don't wait on virtio-snd.

### 4. Webcam — coolest, heaviest, lowest certainty

The flashiest option and the one with the least off-the-shelf support.

- **No QEMU-emulated camera exists** that a Zephyr driver consumes. Zephyr's
  video subsystem tests against a *software pattern generator* on `native_sim`,
  not against an emulated capture device under QEMU.
- So this needs a **new bespoke Zephyr `video` driver** reading frames from a
  host buffer, plus a QEMU device to carry them — combining the host-sensor
  (frames pushed in) and framebuffer-export (a buffer both sides share) shapes.
  `getUserMedia` → shared frame buffer → guest `video` driver →
  `samples/drivers/video/capture`.

It is buildable and it would be a great demo, but it is the largest guest-driver
lift of anything here and carries the most unknowns. Park it as a stretch goal
behind GPIO, virtio, and audio.

## The input gap — ✅ closed, the clean way

**Implemented** as a virtio tablet, exactly the route this section used to say
was unavailable. The framebuffer panel is no longer output-only: clicks and
drags on it press the guest's touchscreen.

The reason it turned out cheap is that the gap was never really ours to close.
Zephyr's `virtio,input` driver landed upstream in June 2026
([`drivers/input/input_virtio.c`](https://github.com/zephyrproject-rtos/zephyr/blob/main/drivers/input/input_virtio.c)),
and the same series wired `virtio_input0` into the `qemu_cortex_a53`
devicetree with `chosen { zephyr,touch }` already pointing at it. So the guest
side is *one Kconfig symbol* — `CONFIG_INPUT=y`
([`zephyr-module/conf/touch.conf`](../zephyr-module/conf/touch.conf)) — with no
shield overlay and no driver of ours. LVGL builds a pointer indev from the same
chosen node, which is why the Music Player demo became clickable with no
application change.

That demo also lost `LV_DEMO_MUSIC_AUTO_PLAY`, and the reason is worth
recording because the old config comment asserted the opposite. Auto play is
not an endless animation: it is a fixed 41-step script, and its last two steps
cover the UI with an opaque "The average FPS is" overlay and then load a blank
screen. The packaged Music Player was therefore going dead after ~35 s — with
the FPS number missing, since that label is only filled when
`LV_USE_PERF_MONITOR` is on. A demo that waits for a click is strictly better
now that clicks arrive.

The browser side is `tools/qemu-jit-patches/0009-hw-misc-add-browser-input-bridge.patch`
plus [`src/hostInput.ts`](../src/hostInput.ts). It is a *fourth bridge shape*,
and the first one that carries no device:

4. **Host → guest, no device at all — browser input.**
   The device model (`virtio-tablet-device`) and the guest driver both already
   exist; what is missing is the thing that normally feeds QEMU's input core,
   because a `--without-default-features` build has no SDL/GTK/VNC. The patch
   supplies that frontend and nothing else: JS appends `(kind, code, value)`
   records to a lock-free ring, a `QEMU_CLOCK_VIRTUAL` timer replays them into
   `qemu_input_queue_abs`/`_btn` under the BQL. Reach for this shape whenever
   QEMU already models the device and only the *host* end is missing.

Two details worth keeping:

- **The write index is published once per packet**, not per record, so a drain
  never sees coordinates without the `SYNC` that commits them — the guest would
  otherwise act on a half-delivered position.
- **The primary button is `BTN_TOUCH`, not `BTN_LEFT`.** Zephyr's touch
  consumers read `INPUT_BTN_TOUCH`: LVGL's pointer indev accepts either, but
  `samples/subsys/input/draw_touch_events` only handles `BTN_TOUCH`. Sending
  `INPUT_BUTTON_TOUCH` (QEMU maps it to `BTN_TOUCH`) satisfies both without
  emitting two events per press.

Keyboard is deliberately *not* wired up. The bridge carries a `KEY` record kind
and translates Linux evdev codes through `qemu_input_linux_to_qcode()`, so a
`virtio-keyboard-device` is a small follow-up — but typing already works, it
goes to the serial terminal, and a second keyboard competing for focus with the
shell is a UX problem before it is a driver problem.

## Suggested order

1. ~~**GPIO (buttons + LEDs)**~~ — ✅ done; landed on the M3 shell image. Follow-up:
   wire a GPIO IRQ to the NVIC so the interrupt-driven button sample works too.
2. ~~**virtio, as an exploratory track**~~ — ✅ done, and by a shorter route than
   the entropy/console proof-of-transport this list proposed: **virtio-net**
   (Ethernet) and **virtio-input** (the display's touchscreen) both ship
   against stock QEMU device models and upstream Zephyr drivers. Building
   virtio-entropy now would prove nothing new. Follow-up candidate:
   a `virtio-keyboard-device`, for which the input bridge already carries the
   record kind.
3. ~~**Audio (out + mic)**~~ — ✅ done; bespoke PCM bridges on both machines
   behind Zephyr's standard I2S (out) and DMIC (in) APIs, Web Audio on the
   browser side, not virtio (see
   [`audio-feasibility.md`](audio-feasibility.md)). Follow-up candidate: an
   I2S echo-style sample tying mic to speaker in one app.
4. **Webcam** — stretch; needs a new Zephyr video driver, most uncertain.

## Sources

- [Zephyr VIRTIO documentation](https://docs.zephyrproject.org/latest/hardware/virtualization/virtio.html)
- [Antmicro: Extended Virtio support in Zephyr](https://antmicro.com/blog/2025/10/extended-virtio-support-in-zephyr)
- [PR #89460 — virtio-mmio transport driver](https://github.com/zephyrproject-rtos/zephyr/pull/89460)
- [PR #94807 — virtio serial/console driver](https://github.com/zephyrproject-rtos/zephyr/pull/94807)
- [PR #83892 — VIRTIO device API + PCI driver](https://github.com/zephyrproject-rtos/zephyr/pull/83892)
- [Zephyr video capture sample](https://docs.zephyrproject.org/latest/samples/drivers/video/capture/README.html)
