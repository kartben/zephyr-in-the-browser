# Zephyr in the Browser

**[▶ Try it live](https://kartben.github.io/zephyr-in-the-browser/)**. The [Zephyr RTOS](https://zephyrproject.org/) running in a browser tab, no hardware or install required.

Pick a **board** and an **app**, then learn from what you can see: the
**terminal**, the **device dock** (peripherals wired to the running build’s
devicetree), and instruments like **Trace** and **Debug**. Any dock row can pop
out into a floating window; collapsed rows keep a live readout.

| Device | What you see |
| --- | --- |
| **Sensors** | Simulated I²C parts (TMP112 and LM75 thermometers, ADXL345 and LSM6DSO motion, LPS22HH pressure, INA219 power, ISL29035 light), each a row of sliders and config bits, read through stock Zephyr drivers. Motion sensors can follow your device's real tilt; the LSM6DSO sample shows `sensor_attr_set` configuring the sampling rate |
| **RTC** | A PCF8523 real-time clock: live date/time, sync from the browser, and alarm armed/fired state, through Zephyr's stock RTC driver and shell (`rtc get` / `rtc set_alarm`) |
| **Aux display** | A Grove JHD1313 16×2 character LCD with RGB backlight. Zephyr's stock auxdisplay driver writes "Hello World"; watch it in the dock |
| **LED matrix** | A Holtek HT16K33 16×8 LED driver. Stock `samples/drivers/ht16k33` walks, blinks and dims the matrix in the dock |
| **RGB LED** | A TI LP5562 RGBW LED, a TI LP5012 strip, or a Worldsemi WS2812 strip. Stock LED samples cycle colors; the dock paints orbs and channel meters |
| **PWM** | An NXP PCA9685 16-channel PWM. Stock `samples/drivers/led/pwm` fades and blinks via `pwm-leds`; the dock shows LED brightness and a duty-cycle chart |
| **DAC** | A Microchip MCP4725 12-bit DAC. Stock `samples/drivers/dac` writes a sawtooth; the dock charts Vout over time |
| **Fuel gauge** | A Maxim MAX17048. Stock `samples/drivers/fuel_gauge` polls SoC % and voltage; the dock paints a battery card |
| **GPIO** | Clickable buttons (`gpio-keys`) and a separate LED-class row for `gpio-leds`, wired per the running build’s tree |
| **Buzzer** | A `gpio-buzzer` on a dedicated output pin. The dock shakes and vibrates (or buzzes) when the guest drives it |
| **Stepper** | GPIO step/dir (`samples/drivers/stepper/generic`) or an Analog Devices TMC50xx on SPI (`samples/drivers/stepper/tmc50xx`). The dock dial tracks position/velocity |
| **GNSS** | An editable fix, streamed to the guest over UART and parsed by Zephyr's stock NMEA driver |
| **Display** | Zephyr's display driver painting a framebuffer, plus a touchscreen: clicks and drags on the display peripheral. Pop the dock row out when you want the pixels big |
| **Audio** | Speakers fed by Zephyr's I2S API and a microphone feeding its DMIC API |
| **I²C** | The bus itself: attach and detach chips while the guest runs, watch every byte that crosses, and read the AT24 EEPROM as a live hex dump or the SSD1306 OLED's pixels |
| **SPI** | A SPI bus with JEDEC NOR flash: hex dump, LittleFS browser, and persist so `samples/subsys/fs/littlefs` boot-counts survive reload. The same bus can host an SCT2024 LED bar, a WS2812 strip, or a TMC50xx stepper when those samples are selected |
| **Network** | Ethernet with throughput charts and a packet capture. DHCP, HTTP, and echo samples talk through Network — or flip the panel's **Uplink** to bridge frames over a WebSocket to a [self-hosted gateway](docs/net-gateway.md) (one `docker run`, passt-based) for real DHCP, DNS, TCP/UDP, even real ping |
| **Guided tours** | A **stock** sample that explains itself. Each step pauses the **guest** and shows what it finds: live values, a hexdump, registers, the thread list. Nothing is added to the firmware. Try **Blinky** or **Dining Philosophers**; see [docs/tours.md](docs/tours.md) |

## Quick start

```console
npm install
npm run dev
```

Open <http://localhost:5173>. You'll land on a **mock backend**: a fake shell that echoes input and answers a few commands, so the UI works out of the box without a full emulator build.

To boot real Zephyr, build the emulator and a sample image, then restart the dev server:

```console
tools/build-qemu-wasm.sh     # builds the emulator -> public/qemu/ (slow, containerised)
tools/build-zephyr-image.sh  # builds every sample in tools/samples.manifest
npm run dev
```

`build-qemu-wasm.sh` runs in a container (Emscripten). `build-zephyr-image.sh`
prefers your **local Zephyr** workspace (`ZEPHYR_WS`, default `~/zephyrproject`)
and builds samples in parallel so you can rebuild many apps at once. Set
`ZEPHYR_DOCKER=1` to force the container path, or `ZEPHYR_NATIVE=1` to force
native. The app switches to QEMU automatically once it finds a build. See
[public/qemu/README.md](public/qemu/README.md) for details.

### Real network access (optional)

By default the guest's LAN is simulated in the page and nothing reaches the
internet. To bridge it onto a real network, run the gateway and paste the URL
it prints into the Network panel's **Uplink** section:

```console
docker run --rm --security-opt seccomp=unconfined -p 8737:8737 ghcr.io/kartben/zephyr-in-the-browser/gateway
```

See [docs/net-gateway.md](docs/net-gateway.md) for tunnels (public `wss://`
links), security notes and alternatives.

## Choosing what runs

Pick a **board** and an **app** from the top bar. You can also drop your own ELF
onto the window to boot it instead: anything built for that board works, not
just Zephyr. Dropped ELFs assume tracing may be enabled, so **Trace** opens by
default.

On Cortex-A53 every sample ships **with and without tracing** (gallery rows
marked **traced**). The packaged apps are listed in
[`tools/samples.manifest`](tools/samples.manifest); the build script expands
each A53 entry into a `_trace` twin via the `browser-tracing` snippet. Cortex-M3
lists apps verified against its slower timing. Most run (including
single-threaded sleepers like `blinky` and `basic_button`, albeit not at
wall-clock speed), but a few multi-threaded ones stall; Cortex-A53 is the focus
for new work ([docs/focus.md](docs/focus.md)).

---

Working on the emulator itself? [`docs/`](docs/) covers the internals: QEMU,
WebAssembly, bridges, and board focus.
