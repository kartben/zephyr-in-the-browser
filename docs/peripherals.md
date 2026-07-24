# How browser peripherals reach the guest

The guest-facing half of every browser-backed device: the Zephyr shield that
declares them, the two vendored drivers behind snippets, and touch input — the
one that needed no shield entry at all.

For the host-facing half — what each bridge costs in QEMU C, and which shape a
new device should reuse — see [next-drivers.md](next-drivers.md) and
[virtio-bridge.md](virtio-bridge.md).

## The browser_bridge shield

The browser-fed peripherals — GNSS UART, host GPIO, host audio out (I2S), host
microphone (DMIC), and the browser-sized ramfb — reach the guest through a
Zephyr shield, **`browser_bridge`**
([zephyr-module/boards/shields/browser_bridge/](../zephyr-module/boards/shields/browser_bridge)),
applied to every packaged build. Building any app against the browser machines
is just:

```console
west build -b qemu_cortex_m3 <app> -- -DZEPHYR_EXTRA_MODULES=<repo>/zephyr-module -DSHIELD=browser_bridge
```

Each machine instantiates the devices where the overlays expect them: the
Stellaris patches in `tools/qemu-patches/` put the GPIO controller at
0x40061000, the audio out at 0x40062000 and the microphone at 0x40063000; the
virt patches in `tools/qemu-jit-patches/` put the audio out at 0x090d0000 and
the microphone at 0x090e0000.

Sensors used to be here too, as a `qemu,host-sensor` MMIO device aliased
`accel0`/`temp0`/`light0`/…, so stock sensor samples bound to a bespoke device
invented for this project. They are now **simulated I²C parts** instead (below),
which is a better trade: the guest binds *unmodified in-tree drivers* to chips
that behave like the real silicon. The MMIO device is still instantiated by
`tools/qemu-patches/0001-…-host-sensor.patch` and its virt counterpart, but no
devicetree node references it, so nothing binds it and it does nothing. Those
two patches are retired on the next qemu-wasm rebuild — the audio, mic and GPIO
patches carry their lines as diff context, so dropping them is a rebase of the
series rather than a deletion.

## Simulated I²C sensors

The A53's VIRTIO I²C adapter (`-S virtio-i2c`) carries chips that are
*TypeScript*, not C: a TMP112 and an LM75 thermometer, an ADXL345
accelerometer, an AT24 EEPROM and an SSD1306 OLED, all under
[`src/virtio/devices/`](../src/virtio/devices). The guest side is entirely
stock — `ti,tmp112`, `lm75`, `adi,adxl345`, `atmel,at24`, `solomon,ssd1306` —
so `sensor get adxl345@53` reads a value the page made up through the same
driver a real board would use.

Sensors are declared rather than hand-written
([`src/virtio/devices/sensors/model.ts`](../src/virtio/devices/sensors/model.ts)):
a part lists its registers, the channels a human drives and the config bits it
exposes, and the framework synthesises both the chip's register machine and its
control card. Adding a sensor is a declaration plus a devicetree node in
[`zephyr-module/snippets/virtio-i2c/`](../zephyr-module/snippets/virtio-i2c)
and its `CONFIG_*` in [`conf/i2c.conf`](../zephyr-module/conf/i2c.conf).

Because the bus is page-side, chips can be **attached and detached while the
guest runs**. Detaching one the devicetree declares makes its driver NAK
exactly as if the part fell off the board; attaching at an address the
devicetree does not declare answers `i2c scan` but binds no driver. The
`accel0` alias lives in the virtio-i2c snippet rather than the shield, so a
build without the bus never carries a dangling alias.

## The vendored drivers

The module also carries pristine copies of two not-yet-upstream Zephyr drivers
([`zephyr-module/drivers/vendor/`](../zephyr-module/drivers/vendor)), each opt-in
behind a snippet:

- **virtio-gpu** (`-S virtio-gpu`) swaps the Cortex-A53 panel off ramfb. Proven
  on the guest side but with no browser bridge yet, so nothing renders in the
  page under it — and measurements say it is not the way to a faster display
  anyway. Written up in
  [next-drivers.md](next-drivers.md#virtio-gpu--vendored-guest-side-proven-not-a-display-speed-up).
- **virtio-gpio** (`-S virtio-gpio`) gives the Cortex-A53 the GPIO panel, on
  virtio-mmio slot 2. This is the same browser buttons and LEDs the Cortex-M3
  gets from `qemu,host-gpio`, but reached through a *standard* device: the guest
  runs a stock VIRTIO driver instead of one written against a bespoke register
  block, and because the device offers `VIRTIO_GPIO_F_IRQ`, buttons interrupt
  the guest rather than being polled by it. The trade is latency — every GPIO
  call is a virtqueue round trip, so the API is thread-context only.

  Going virtio does *not* remove the downstream QEMU patch: `hw/virtio/` ships
  only `vhost-user-gpio`, which forwards the virtqueues to a separate daemon
  process, and a wasm build in a browser tab has none to run. What changed is
  where the bespoke part lives. It is no longer a GPIO device model in C but a
  **generic virtio bridge**
  ([`tools/qemu-jit-patches/0010-hw-virtio-add-generic-browser-virtio-bridge.patch`](../tools/qemu-jit-patches/0010-hw-virtio-add-generic-browser-virtio-bridge.patch)),
  which forwards whole virtqueue chains to the page and lets the *device model*
  be TypeScript — [`src/virtio/devices/gpio.ts`](../src/virtio/devices/gpio.ts).
  The virtio device id, queue count, features and config space are command-line
  properties, so the same C file is a GPIO controller, an I2C adapter, or
  whatever comes next, and adding one needs no QEMU rebuild. See
  [virtio-bridge.md](virtio-bridge.md). The Cortex-M3 keeps its MMIO
  device: the LM3S6965 machine has no virtio-mmio bus.

## Touch input: the display panel is a tablet

Clicking and dragging on the Cortex-A53 display panel presses the guest's
touchscreen. It reaches Zephyr as a **stock `virtio-tablet-device`** on
virtio-mmio slot 3 — the slot the board's own devicetree reserves for
`virtio_input0`, with `zephyr,touch` already pointing at it — driven by
Zephyr's upstream `virtio,input` driver. Nothing in this repo models the
device, and there is no shield overlay for it; a build only needs
`CONFIG_INPUT=y` ([`zephyr-module/conf/touch.conf`](../zephyr-module/conf/touch.conf))
to compile the driver the devicetree already asks for. LVGL picks the pointer
up from the same chosen node, so the Music Player demo became clickable without
an application change — and it now waits for that click instead of running
LVGL's auto-play script, which ended by blanking the screen after ~35 seconds.

What the emulator *does* need is a way in. QEMU's input core is normally fed by
a UI backend, and qemu-wasm is built without SDL, GTK or VNC, so
`tools/qemu-jit-patches/0009-hw-misc-add-browser-input-bridge.patch` supplies
the missing frontend: page JavaScript ([`src/hostInput.ts`](../src/hostInput.ts))
appends events to a lock-free ring and a `QEMU_CLOCK_VIRTUAL` timer replays
them into `qemu_input_*()` on QEMU's own thread. That makes it the first bridge
here whose *device* is entirely off-the-shelf on both sides — the patch adds
plumbing, not hardware. The primary button is reported as `BTN_TOUCH` rather
than `BTN_LEFT`, which is what Zephyr's touch consumers read; the secondary and
middle buttons and the wheel pass through for anything that wants them.
