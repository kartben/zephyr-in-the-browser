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

### 1. GPIO — buttons and LEDs — do this first

The highest demo-value-per-effort item, and it reuses shapes we already have in
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
- **virtio-net** listed as upcoming.

That means a virtio device could become **the first peripheral that runs against
stock QEMU with no C patch of ours** — the transport is already in upstream QEMU
and the driver is already in Zephyr. That is a meaningful reduction in the
per-device cost that shapes 1–3 all pay.

**The catch, and why it is a bet not a slam dunk:** the *exciting* virtio
endpoints do not have Zephyr drivers yet. There is **no virtio-snd, no
virtio-gpu, and no virtio-input** driver in Zephyr. So virtio's near-term payoff
is plumbing, not a flashy new panel. Concretely, the tractable first targets are:

- **virtio-entropy** — smallest possible proof that the qemu-wasm virtio-mmio
  path works end to end. A `hwrng`/entropy source is not a UI showpiece, but it
  validates the whole transport with almost no surface area.
- **virtio-console** — a second console channel over virtio-mmio instead of the
  PL011 hack we use for GNSS. Proves a stream device on virtio and de-risks the
  chardev-patch approach for future stream peripherals.

Recommendation: treat virtio as a **separate, exploratory track from GPIO**,
sequenced second. Land virtio-entropy or virtio-console purely to prove the
transport in qemu-wasm. Do *not* frame virtio as "the way we'll get audio/webcam"
— that would require writing new Zephyr virtio drivers, which is a research
project of its own (see below).

### 3. Audio — output first, and *not* via virtio

Appealing, and doable, but bespoke. Because there is no virtio-snd driver in
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

## The input gap, called out

The README's "Not in v1" notes there is no display input bridge — the framebuffer
panel is output-only, keyboard still goes to the serial terminal, and there is no
mouse/tablet. The *clean* way to close that is **virtio-input**, and Zephyr has no
virtio-input driver, so the clean way is not available yet. If a mouse/tablet for
the display becomes a priority before that lands upstream, it would have to be a
bespoke input device rather than virtio — worth knowing before anyone reaches for
it expecting virtio to just cover it.

## Suggested order

1. **GPIO (buttons + LEDs)** — cheapest, most interactive, reuses both directions,
   guest driver is stock. Start on the M3 shell image.
2. **virtio-entropy or virtio-console** — separate exploratory track; prove the
   virtio-mmio path works in qemu-wasm against stock QEMU, no C patch of ours.
3. **Audio out** — bespoke host-PCM bridge on the framebuffer-export shape, Web
   Audio on the browser side. Not virtio.
4. **Webcam** — stretch; needs a new Zephyr video driver, most uncertain.

## Sources

- [Zephyr VIRTIO documentation](https://docs.zephyrproject.org/latest/hardware/virtualization/virtio.html)
- [Antmicro: Extended Virtio support in Zephyr](https://antmicro.com/blog/2025/10/extended-virtio-support-in-zephyr)
- [PR #89460 — virtio-mmio transport driver](https://github.com/zephyrproject-rtos/zephyr/pull/89460)
- [PR #94807 — virtio serial/console driver](https://github.com/zephyrproject-rtos/zephyr/pull/94807)
- [PR #83892 — VIRTIO device API + PCI driver](https://github.com/zephyrproject-rtos/zephyr/pull/83892)
- [Zephyr video capture sample](https://docs.zephyrproject.org/latest/samples/drivers/video/capture/README.html)
