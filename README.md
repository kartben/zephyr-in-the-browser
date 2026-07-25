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
| **Sensors** | Simulated I²C parts — TMP112 and LM75 thermometers, an ADXL345 accelerometer — each a row of sliders and config bits, read through stock Zephyr drivers. The accelerometer can follow your device's real tilt |
| **GPIO** | Clickable buttons and live LED indicators, wired per the devicetree's `gpio-keys`/`gpio-leds` |
| **GNSS** | An editable fix, streamed to the guest over UART and parsed by Zephyr's stock NMEA driver |
| **Display** | Zephyr's display driver painting a framebuffer — and a *touchscreen*: clicks and drags arrive as a virtio-input tablet. Output, not controls, so it floats on the stage |
| **Audio** | Speakers fed by Zephyr's I2S API and a microphone feeding its DMIC API, wired to Web Audio and `getUserMedia` |
| **I²C** | The bus itself, on its controller node: attach and detach chips while the guest runs, watch every byte that crosses, and read the AT24 EEPROM as a live hex dump or the SSD1306 OLED's pixels. A chip the devicetree declares but nothing answers for shows as a ghost row — the NAK made visible |
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
