# Zephyr in the Browser

**[▶ Try it live](https://kartben.github.io/zephyr-in-the-browser/)** — the [Zephyr RTOS](https://zephyrproject.org/) shell running in a browser tab, no hardware or install required.

It's [QEMU](https://www.qemu.org/) compiled to WebAssembly with Emscripten,
emulating Cortex-M3 and Cortex-A53 boards. Alongside the serial terminal, every
browser-backed peripheral lives in the **device dock** — one scrollable sidebar
with two arrangements of the same controls: a tree that mirrors the running
build's devicetree (chips under their I²C bus, the GNSS receiver under its
UART, real node names and compatibles), and a view grouped by peripheral class.
Any row pops out into a floating window; collapsed rows keep a live readout.

| Device | What the guest sees |
| --- | --- |
| **Sensors** | Simulated I²C parts — TMP112 and LM75 thermometers, ADXL345 and LSM6DSO motion, LPS22HH pressure, INA219 power, ISL29035 light — each a row of sliders and config bits, read through stock Zephyr drivers. Motion sensors can follow your device's real tilt; the LSM6DSO sample shows `sensor_attr_set` configuring the sampling rate |
| **RTC** | A PCF8523 real-time clock: live date/time, sync from the browser, and alarm armed/fired state — through Zephyr's stock RTC driver and shell (`rtc get` / `rtc set_alarm`) |
| **Aux display** | A Grove JHD1313 16×2 character LCD with RGB backlight — Zephyr's stock auxdisplay driver writes "Hello World"; the backlight is a JSON register map at 0x62 |
| **LED matrix** | A Holtek HT16K33 16×8 LED driver at 0x70 — stock `samples/drivers/ht16k33` walks, blinks and dims the matrix; the dock paints display RAM with a JSON register map |
| **PWM** | An NXP PCA9685 16-channel PWM at 0x60 — stock `samples/drivers/led/pwm` fades and blinks via `pwm-leds`; the dock shows LED brightness and an annotated duty-cycle chart |
| **DAC** | A Microchip MCP4725 12-bit DAC at 0x61 — stock `samples/drivers/dac` writes a sawtooth; the dock charts Vout over time (framework-ready for more DAC parts) |
| **GPIO** | Clickable buttons and live LED indicators, wired per the devicetree's `gpio-keys`/`gpio-leds` |
| **Buzzer** | A `gpio-buzzer` on a dedicated output pin — the dock shakes a Lucide icon and vibrates (or buzzes via Web Audio) when the guest drives it |
| **GNSS** | An editable fix, streamed to the guest over UART and parsed by Zephyr's stock NMEA driver |
| **Display** | Zephyr's display driver painting a framebuffer — and a *touchscreen*: clicks and drags arrive as a virtio-input tablet. Output, not controls, so it floats on the stage |
| **Audio** | Speakers fed by Zephyr's I2S API and a microphone feeding its DMIC API, wired to Web Audio and `getUserMedia` |
| **I²C** | The bus itself, on its controller node: attach and detach chips while the guest runs, watch every byte that crosses, and read the AT24 EEPROM as a live hex dump (persisted across reloads; erase clears it) or the SSD1306 OLED's pixels. A chip the devicetree declares but nothing answers for shows as a ghost row — the NAK made visible |
| **Network** | Real Ethernet — the page itself implements the LAN, with throughput charts and a tcpdump-style capture |

## Quick start

```console
npm install
npm run dev
```

Open <http://localhost:5173>. You'll land on a **mock backend** — a fake shell that echoes input and answers a few commands — so the UI works out of the box without a ~100 MB QEMU build.

To boot real Zephyr, build the emulator and a guest image, then restart the dev server:

```console
tools/build-qemu-wasm.sh     # builds the emulator -> public/qemu/ (slow, containerised)
tools/build-zephyr-image.sh  # builds every sample in tools/samples.manifest, both boards
npm run dev
```

Both scripts run in containers, so no local Emscripten or Zephyr toolchain is needed. The app switches to QEMU automatically once it finds a build. See [public/qemu/README.md](public/qemu/README.md) for details.

## Choosing what runs

Pick a **Board** (the emulated machine) and an **App** (the program it boots) from the top bar. You can also drop your own ELF onto the window to boot it instead — anything QEMU can run with `-kernel` works, not just Zephyr.

The packaged apps are listed in [`tools/samples.manifest`](tools/samples.manifest). Cortex-M3 lists apps verified against its slower qemu-wasm TCI timing — most run (including single-threaded sleepers like `blinky` and `basic_button`, albeit not at wall-clock speed), but a few multi-threaded ones stall; Cortex-A53 runs the wasm JIT and is unaffected.

---

Working on the emulator itself? [`docs/`](docs/) covers the internals.
