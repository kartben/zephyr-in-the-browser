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

## Simulated I²C chips

The A53's VIRTIO I²C adapter (`-S virtio-i2c`) carries chips that are
*TypeScript*, not C: TMP112 and LM75 thermometers, an ADXL345 accelerometer,
an AT24 EEPROM and an SSD1306 OLED by default, under
[`src/virtio/devices/`](../src/virtio/devices). Optional extras — an LSM6DSO
IMU, an LPS22HH barometer, an INA219 power monitor, an ISL29035 light
sensor, a PCF8523 RTC, a JHD1313 character LCD (Grove RGB, with its
PCA9633-style backlight at `0x62`), and an HT16K33 LED matrix at `0x70` —
stay `status = "disabled"` in the
virtio-i2c overlay so everyday builds (accel chart, OLED display, …) do not
clutter the dock. The shell turns most of them on with `-S i2c-sensors-extra`;
each dedicated sensor / RTC / auxdisplay / LED sample uses a `*-only` snippet that
enables that part and disables the default temperature / accel nodes. The
EEPROM sample uses `-S eeprom-only` the same way (sensors and OLED off,
`eeprom-0` aliased). The page attaches matching models only while the guest
tree marks those nodes okay.

The guest side is entirely stock — `ti,tmp112`, `lm75`, `adi,adxl345`,
`st,lsm6dso`, `st,lps22hh`, `ti,ina219`, `isil,isl29035`, `nxp,pcf8523`,
`atmel,at24`, `solomon,ssd1306`, `jhd,jhd1313`, `holtek,ht16k33` — so `sensor get lps22hh@5c`
reads a value the page made up through the same driver a real board would use. The LSM6DSO is the
advanced motion case: Zephyr's `samples/sensor/lsm6dso` calls `sensor_attr_set`
to put accel and gyro at 12.5 Hz, and the panel's ODR selects update when those
CTRL register writes land.

Chips are **declared rather than hand-written**, by whichever of three small
frameworks fits, and each synthesises both the chip's behaviour on the bus and
the card that drives it — so adding a part is a declaration, not another panel:

- **Sensors** ([`sensors/model.ts`](../src/virtio/devices/sensors/model.ts)) —
  a part lists its registers, the channels a human drives and the config bits it
  exposes. The framework builds the register machine (pointer, read-only vs
  read-write registers, channel values encoded at read time, optional
  auto-incrementing burst reads) and a card of sliders and toggles. A channel
  can name a browser source, which is how the ADXL345's axes follow the
  device's real tilt.
- **Memory** ([`memory/model.ts`](../src/virtio/devices/memory/model.ts)) —
  a part lists its geometry: size, word-address width, page size, erased value.
  The framework builds the word-address pointer with its auto-increment and
  wrap, and a card that is a live hex dump. Erased cells are dimmed so written
  bytes stand out, bytes the guest just changed light up, the read pointer is
  marked, and clicking a byte edits it — so you can plant something in the
  EEPROM and go read it from the shell. The board AT24 also persists its
  backing store in `localStorage` (`zephyr.eeprom.50`) across page reloads, so
  Zephyr's stock `samples/drivers/eeprom` boot counter keeps counting after an
  "MCU reset"; the card's **erase** button clears both the live image and the
  stored one. The hex dump *is* the fine-grained view — EEPROMs are a flat
  address space, not named SVD registers.
- **RTC** ([`rtc/model.ts`](../src/virtio/devices/rtc/model.ts)) — a
  bus-agnostic datetime + alarms surface (`getTime` / `setTime` /
  `syncFromBrowser` / `getAlarms`). The first provider is the I²C PCF8523 at
  `0x68`; the dock body keys off the RTC handle, not the bus, so a later
  non-I²C RTC can reuse the same card. Alarms show as armed / fired when the
  guest (or the card) programs the compare registers — shell
  `rtc set_alarm` under `CONFIG_RTC_ALARM`.

**Register maps** are shared across register-file parts — sensors, the
PCF8523, both halves of the JHD1313, and the HT16K33 today — via [`registers/`](../src/virtio/devices/registers)
(SVD-inspired JSON under `sensors/maps/`, `rtc/maps/`, and `chips/maps/`) and
the collapsed **Registers** dialog on each card
([`RegisterMap.tsx`](../src/components/RegisterMap.tsx)). Channel codecs and
RTC BCD timekeeping stay in their own frameworks; the map is data. The SSD1306
stays a pure *command stream* (Controller inspector, no fake SVD rows). The
JHD1313 LCD address *does* get a map — Instruction (0x00) / Instruction_Co
(0x80) / Data (0x40) plus decoded Entry_Mode, Display_Control, Function_Set,
and DDRAM_AC shadows (`chips/maps/jhd1313-lcd.json`) — and its backlight at
0x62 is a separate PCA9633-style map (`jhd1313-backlight.json`). The HT16K33
maps display RAM rows 0x00–0x0F plus System_Setup / Display_Setup / Row_Int /
Dimming (`chips/maps/ht16k33.json`).

Either way, the guest half is a devicetree node in
[`zephyr-module/snippets/virtio-i2c/`](../zephyr-module/snippets/virtio-i2c)
and a `CONFIG_*` in [`conf/i2c.conf`](../zephyr-module/conf/i2c.conf).

Because the bus is page-side, chips can be **attached and detached while the
guest runs**. Detaching one the devicetree declares makes its driver NAK
exactly as if the part fell off the board; attaching at an address the
devicetree does not declare answers `i2c scan` but binds no driver. The
`accel0` alias lives in the virtio-i2c snippet rather than the shield, so a
build without the bus never carries a dangling alias.

## The devicetree is the source of truth

What the panels show is grounded in the *running build's* flattened
devicetree, not in hardcoded mirrors of the overlays.
[`tools/build-zephyr-image.sh`](../tools/build-zephyr-image.sh) ships each
sample's `build/zephyr/zephyr.dts` next to its ELF; the page parses it
([`src/dts/`](../src/dts)) into a store ([`src/devicetree.ts`](../src/devicetree.ts))
that the peripheral surfaces read:

- which I2C addresses have a bound driver (the "driver"/"bus only" tags, from
  the bridged `virtio,i2c` node's enabled children),
- the GPIO panel's pins and labels (from `gpio-keys`/`gpio-leds` wiring) and
  the controller name its shell hints quote,
- which panels exist at all — a build without the virtio-i2c snippet shows no
  I2C panel even though the machine always carries the adapter.

A user-supplied ELF gets the same treatment when its `zephyr.dts` is dropped
or picked alongside it; without one, every panel the machine exposes shows
expanded, as before. When no devicetree is known at all (older image
tarballs), the old hardcoded tables in
[`src/virtio/devices/registry.ts`](../src/virtio/devices/registry.ts) and
[`src/hostGpio.ts`](../src/hostGpio.ts) take over, so nothing regresses.

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
