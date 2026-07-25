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

1. **Host → guest, shared memory** — `qemu,host-gpio`.
   JS writes into memory the guest reads over MMIO. No proxying, no JS on the
   guest's read path. See [`src/hostGpio.ts`](../src/hostGpio.ts),
   [`zephyr-module/drivers/qemu_host_gpio.c`](../zephyr-module/drivers/qemu_host_gpio.c),
   and `tools/qemu-patches/0005-hw-misc-add-qemu-host-gpio.patch`.
   *Cheapest shape.* Good for anything that is "a value the browser knows and the
   guest reads."

   This shape was pioneered by `qemu,host-sensor`, which is now **retired**: a
   sensor behind a bespoke MMIO device needs a bespoke driver, whereas a
   simulated I²C chip on the generic virtio bridge gets the same values into the
   guest through an *unmodified in-tree* driver. Worth weighing before reaching
   for this shape — if the thing you are modelling exists as a real chip on a
   real bus, simulate the chip instead. See
   [peripherals.md](peripherals.md#simulated-ic-sensors) and
   [virtio-bridge.md](virtio-bridge.md).

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

**Interrupts landed on the Cortex-A53 instead**, by a different route: a standard
**VIRTIO GPIO** controller on virtio-mmio slot 2, behind the vendored upstream
`virtio,gpio` driver and the `-S virtio-gpio` snippet. It offers
`VIRTIO_GPIO_F_IRQ`, so `gpio-keys` runs interrupt-driven and
`samples/basic/button` is packaged for that board. The M3 keeps its MMIO device
because the LM3S6965 machine has no virtio-mmio bus to move onto, and because a
pin read there never leaves the guest, where every virtio call is a virtqueue
round trip.

That device *was* 576 lines of C (`hw/virtio/virtio-gpio.c`, JIT patch 0010),
written because QEMU has no virtio-gpio device model — `vhost-user-gpio.c`
forwards the virtqueues to a separate daemon process, which a wasm build in a
tab cannot run. Going virtio had therefore not removed the downstream patch, it
had only moved the bespoke part from the guest to the host, and the next virtio
device would have cost another such file.

**It is now zero lines of C.** The GPIO device model is
[`src/virtio/devices/gpio.ts`](../src/virtio/devices/gpio.ts), running on the
generic bridge described in [virtio-bridge.md](virtio-bridge.md) — see the
section below, which this supersedes. Two things also got *better* in the move,
because the model now lives where the events originate: input edges are exact
rather than sampled on a 10 ms timer, and a guest-driven output notifies the
panel synchronously instead of being polled at 100 ms.

**gpio-buzzer (done).** Stock Zephyr `gpio-buzzer` on a dedicated pin 5 (LED0
stays on 4), packaged as `samples/drivers/buzzer/tone` behind `-S gpio-buzzer`.
No new QEMU device — the page observes the same GPIO outputs LEDs use
(`getBuzzers` / `isBuzzerOn` in `hostGpio.ts`) and a dock body shakes a Lucide
`Vibrate` icon, with `navigator.vibrate` plus a Web Audio square-wave fallback.
Frequency args remain on/off only for the GPIO backend; `pwm-buzzer` is the
pitch follow-up.

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
  the then-current `qemu_host_sensor.c`. *(Done, both ways: the M3 got the
  bespoke device, the A53 a stock VIRTIO GPIO on the generic bridge. The
  host-sensor it was modelled on has since been retired.)*
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

#### The amendment: the host-side cost is now paid once, not per device

The scorecard above is still true device by device, but it stopped being the
thing that governs the *next* device. The host side is now a single generic
bridge — [`virtio-bridge.md`](virtio-bridge.md), JIT patch 0010 — that carries
whole virtqueue chains out to the page and takes its device id, queue count,
feature bits and config space from the QEMU command line. So:

- A new virtio **device type** costs no C and no QEMU rebuild. It is a
  TypeScript file under `src/virtio/devices/` plus one `-device` argument.
- What remains per device is the **guest driver**, when Zephyr does not already
  have one. For virtio-i2c it does not, and that — not the QEMU side — is now
  the dominant cost of the next device.

The proof is virtio-gpio: 576 lines of C device model deleted, replaced by
`src/virtio/devices/gpio.ts`, with the guest binary, the vendored `virtio,gpio`
driver and the devicetree all untouched. Restated, the rule is now: **virtio
removes the guest-side cost; the bridge removes the per-device host-side one;
what is left is whichever side has no driver yet.**

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

The browser-side render worker already skips unchanged frames via a checksum
(and skips the checksum itself once a short dirty streak shows the guest is
animating). A virtio-gpu flush event would still be nicer than guessing from
pixels, but it is no longer what stands between a still panel and a wasted
upload. For the LVGL accelerometer chart specifically, the packaged build is a small
fork (`zephyr-module/apps/accelerometer_chart`) that uses circular chart updates
and a 480×320 ramfb (`-S accel-display`), sampling at 25 Hz with 40 points —
because the upstream SHIFT-mode full-screen chart outpaces what the emulated
A53 can paint even when I²C is quiet.

So the case for finishing virtio-gpu is *not* frame rate. It is a clean damage
signal and the broader "guest display over virtio" story once a wasm bridge
exists.

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

### 4. The I²C class backlog — cheaper than any new bridge

GPIO / virtio / audio closed the *bridge* shapes. What is left that still pays
well is almost never another QEMU device: it is another **binding type** on the
bus we already have. Zephyr's
[`dts/bindings/binding-types.txt`](https://github.com/zephyrproject-rtos/zephyr/blob/main/dts/bindings/binding-types.txt)
lists dozens of peripheral classes; the ones that fit this project are the ones
with an in-tree I²C (or SPI) driver *and* a stock sample, because the virtio-i2c
bridge means a new chip is TypeScript + a DT node + a JSON register map — no
wasm rebuild.

**Rule for every new I²C part: model the registers.** Sensors and the PCF8523
already share [`registers/`](../src/virtio/devices/registers) (SVD-inspired JSON
under `sensors/maps/` / `rtc/maps/`, live inspector in
[`RegisterMap.tsx`](../src/components/RegisterMap.tsx)). New chips must ship a
map the same way — named registers, access, reset, bitfields — not just enough
bytes for the driver to probe. Command-stream parts (SSD1306 today) stay an
exception and get a controller inspector instead of fake SVD rows. Debt on the
existing tree: LM75, LPS22HH, INA219, and ISL29035 still declare registers
inline without a `maps/*.json`; fold them over when touching those chips.

Classes worth taking next, ranked inside this cheaper track:

#### 4a. Aux display — ✅ done (JHD1313)

**Implemented** as the Grove RGB LCD on virtio-i2c: LCD at `0x3e`
(`src/virtio/devices/chips/jhd1313.ts`) with JSON register map
(`chips/maps/jhd1313-lcd.json` — Instruction / Data ports plus decoded
Entry_Mode, Display_Control, Function_Set, DDRAM_AC) and a PCA9633-style
backlight register file at `0x62`
(`chips/maps/jhd1313-backlight.json`). Dock card paints a 16×2 character-cell
canvas with RGB wash (`AuxdisplayPanel.tsx`); Controller summarises flags,
separate Registers affordances open the LCD and backlight maps. Guest side is
stock `jhd,jhd1313` via `-S jhd1313-only` / `conf/jhd1313.conf`, packaging
`samples/drivers/auxdisplay`.

Original options, kept for the record —

A new dock class (text LCD), not another sensor row. Zephyr's
`auxdisplay` subsystem is exactly "character / segment panel, not framebuffer",
and the stock samples are tiny:

- [`samples/drivers/auxdisplay`](https://docs.zephyrproject.org/latest/samples/drivers/auxdisplay/README.html)
  — "Hello World" on a text display
- [`samples/drivers/auxdisplay_digits`](https://github.com/zephyrproject-rtos/zephyr/tree/main/samples/drivers/auxdisplay_digits)
  — 7-segment / digit panels (TM1637 et al.; usually GPIO-bitbang, so a worse
  fit than the I²C path below)

Two I²C shapes:

1. **`jhd,jhd1313` (shipped).** Grove RGB LCD: one I²C address for the
   HD44780-like command/data stream, a second (`backlight-addr`, default
   `0x62`) for the RGB backlight controller. The backlight side *is* a register
   file and landed as a JSON map; the LCD address is a command stream like the
   SSD1306 and keeps a character-cell canvas + controller state.
2. **`hit,hd44780` behind `nxp,pcf857x`.** The classic I²C backpack. Still a
   good follow-up once someone wants the expander-as-GPIO story.

#### 4b. LED controllers — ✅ done (HT16K33); LP55xx next

**Implemented** as the Holtek HT16K33 on virtio-i2c at `0x70`
(`src/virtio/devices/chips/ht16k33.ts`) with JSON register map
(`chips/maps/ht16k33.json` — display RAM 0x00–0x0F plus System_Setup /
Display_Setup / Row_Int / Dimming). Dock card paints a 16×8 LED matrix
(`LedPanel.tsx`) with brightness and blink; Registers opens the shared map.
Guest side is stock `holtek,ht16k33` via `-S ht16k33-only` / `conf/ht16k33.conf`
(keyscan off), packaging `samples/drivers/ht16k33`. LED index = `row*8+col`
as in Zephyr's driver. LP5562 / LP50xx remain follow-ups under the same dock
class.

Original note, kept for the record —

[`samples/drivers/ht16k33`](https://github.com/zephyrproject-rtos/zephyr/tree/main/samples/drivers/ht16k33)
and the various `samples/drivers/led/*` I²C parts (LP5562, LP50xx, …). Matrix /
RGB LED is a strong dock card and every one of these *is* a register file, so
the map rule applies cleanly. Slightly less "new class" than auxdisplay because
GPIO LEDs already cover the blinky story.

#### 4c. PWM — ✅ done (PCA9685); more providers next

**Implemented** as a bus-agnostic `PwmChip` framework
(`src/virtio/devices/pwm/model.ts`) with the first provider NXP PCA9685 at
`0x60` (`chips/pca9685.ts` + `maps/pca9685.json`). Dock card
(`PwmPanel.tsx` / `PwmBody`) paints an annotated ~1.25-period duty chart and a
channel strip sized from `decl.channelCount` — no PCA9685 imports in the UI.
Guest side: stock `nxp,pca9685-pwm` via `-S pca9685-only` / `conf/pca9685.conf`,
packaging `samples/drivers/led/pwm`. Address is 0x60 to avoid `ina219@40`.

#### 4d. DAC — ✅ done (MCP4725); more providers next

**Implemented** as a bus-agnostic `DacChip` framework
(`src/virtio/devices/dac/model.ts`) with the first provider Microchip MCP4725 at
`0x61` (`chips/mcp4725.ts` + `maps/mcp4725.json`). Dock card
(`DacPanel.tsx` / `DacBody`) paints a Vout-over-time history chart and level bar
sized from `decl` — no MCP4725 imports in the UI. Guest side: stock
`microchip,mcp4725` via `-S mcp4725-only` / `conf/mcp4725.conf`, packaging
`samples/drivers/dac` with `/zephyr,user` dac / channel / resolution props.
Address is 0x61 to avoid `pca9685@60`.

#### 4e. Fuel gauge / charger

`samples/drivers/fuel_gauge` and `samples/drivers/charger` — another dock
class (battery), pure I²C register files. Great once the power-monitor story
(INA219) wants a sibling that speaks "SoC %" rather than "amps".

#### 4f. Webcam — still the stretch

Unchanged: coolest, heaviest, lowest certainty. No QEMU camera a Zephyr driver
consumes; needs a bespoke `video` driver + host buffer →
`samples/drivers/video/capture`. Park it behind the I²C class work.

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

1. ~~**GPIO (buttons + LEDs)**~~ — ✅ done; landed on the M3 shell image, then on
   the A53 as a standard VIRTIO GPIO device, which brought the interrupts the
   MMIO one lacks. Remaining follow-up: wire a GPIO IRQ to the NVIC so the
   Cortex-M3 button sample can stop polling too.
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
4. ~~**Aux display (I²C)**~~ — ✅ done; `jhd,jhd1313` with
   `samples/drivers/auxdisplay`, backlight JSON register map, LCD character-cell
   canvas. HD44780+PCF8574 remains the backpack follow-up.
5. ~~**LED matrix (I²C)**~~ — ✅ done; `holtek,ht16k33` with
   `samples/drivers/ht16k33`, display-RAM JSON map, 16×8 dock canvas. LP55xx
   remains a same-class follow-up.
5½. ~~**gpio-buzzer**~~ — ✅ done; stock `gpio-buzzer` on pin 5 (LED0 stays on
   4), `samples/drivers/buzzer/tone`, dock Lucide shake + Vibration API / Web
   Audio. Observes existing GPIO outputs — no new QEMU device. `pwm-buzzer`
   (pitch) remains a follow-up.
6. ~~**PWM (I²C)**~~ — ✅ done; `PwmChip` framework + `nxp,pca9685-pwm` with
   `samples/drivers/led/pwm`, duty-cycle chart. More PWM providers are
   declaration + packaging only.
6½. ~~**DAC (I²C)**~~ — ✅ done; `DacChip` framework + `microchip,mcp4725` with
   `samples/drivers/dac`, Vout history chart. More DAC providers are
   declaration + packaging only. Then fuel-gauge / charger.
7. **Webcam** — stretch; needs a new Zephyr video driver, most uncertain.

## Sources

- [Zephyr binding types](https://github.com/zephyrproject-rtos/zephyr/blob/main/dts/bindings/binding-types.txt)
- [Zephyr VIRTIO documentation](https://docs.zephyrproject.org/latest/hardware/virtualization/virtio.html)
- [Antmicro: Extended Virtio support in Zephyr](https://antmicro.com/blog/2025/10/extended-virtio-support-in-zephyr)
- [PR #89460 — virtio-mmio transport driver](https://github.com/zephyrproject-rtos/zephyr/pull/89460)
- [PR #94807 — virtio serial/console driver](https://github.com/zephyrproject-rtos/zephyr/pull/94807)
- [PR #83892 — VIRTIO device API + PCI driver](https://github.com/zephyrproject-rtos/zephyr/pull/83892)
- [Zephyr auxdisplay sample](https://docs.zephyrproject.org/latest/samples/drivers/auxdisplay/README.html)
- [Zephyr video capture sample](https://docs.zephyrproject.org/latest/samples/drivers/video/capture/README.html)
