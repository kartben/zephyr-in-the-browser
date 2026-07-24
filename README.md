# Zephyr in the Browser

**[▶ Try it live](https://kartben.github.io/zephyr-in-the-browser/)** — the [Zephyr RTOS](https://zephyrproject.org/) shell running in a browser tab, no hardware or install required.

It's [QEMU](https://www.qemu.org/) compiled to WebAssembly with Emscripten,
emulating Cortex-M3 and Cortex-A53 boards. Alongside the serial terminal, each
browser-backed peripheral gets its own floating panel:

| Panel | What the guest sees |
| --- | --- |
| **Sensor** | A host-fed sensor aliased as `accel0`, `temp0`, `light0`, `humidity0` and `press0`, so stock Zephyr sensor samples run unmodified |
| **GPIO** | Clickable buttons and live LED indicators |
| **GNSS** | An editable fix, streamed to the guest over UART and parsed by Zephyr's stock NMEA driver |
| **Display** | Zephyr's display driver painting a framebuffer — and a *touchscreen*: clicks and drags arrive as a virtio-input tablet |
| **Audio** | Speakers fed by Zephyr's I2S API and a microphone feeding its DMIC API, wired to Web Audio and `getUserMedia` |
| **I²C** | A real bus with simulated chips on it — a TMP112 thermometer, an AT24 EEPROM, and an SSD1306 OLED whose pixels get their own panel — plus every byte that crosses the bus |
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

The packaged apps live in [`tools/samples.manifest`](tools/samples.manifest), one line per board × app with ids matching [`src/boards.ts`](src/boards.ts); `tools/build-zephyr-image.sh` rebuilds them all. Cortex-M3 lists apps verified against its slower qemu-wasm TCI timing — most run (including single-threaded sleepers like `blinky` and `basic_button`, albeit not at wall-clock speed), but a few multi-threaded ones stall; Cortex-A53 runs the wasm JIT and is unaffected.

## How it works

Every device here is a **bridge** between a browser API and a Zephyr driver.
The guest runs stock Zephyr wherever possible; what the page supplies is the
other end of the wire.

| Document | What it covers |
| --- | --- |
| [docs/peripherals.md](docs/peripherals.md) | How the browser-fed devices reach the guest: the `browser_bridge` shield, the vendored drivers behind snippets, and touch input |
| [docs/networking.md](docs/networking.md) | Why the page *is* the LAN, and exactly what does and does not leave the tab |
| [docs/virtio-bridge.md](docs/virtio-bridge.md) | The generic virtio bridge, which lets a device model be TypeScript instead of QEMU C |
| [docs/next-drivers.md](docs/next-drivers.md) | The bridge shapes already proven here, and what to add next |
| [public/qemu/README.md](public/qemu/README.md) | The emulator itself: how it is built, what is patched into it, and its known limits |
| [docs/deploying.md](docs/deploying.md) | Cutting a release and deploying to GitHub Pages |
| [docs/sample-docs.md](docs/sample-docs.md) | The mirrored Zephyr sample docs and their "Run in simulator" widget |

Two closed-out investigations are kept for the evidence rather than the
conclusion: [docs/a53-lvgl-stack.md](docs/a53-lvgl-stack.md) (a guest stack
overflow that looked convincingly like a JIT miscompilation) and
[docs/audio-feasibility.md](docs/audio-feasibility.md) (why audio did not go
over virtio-sound).

## Stack

Vite, React, TypeScript, Tailwind, shadcn/ui, and [`xterm-pty`](https://github.com/mame/xterm-pty) for the terminal. `npm test` runs the vitest suite; `npm run typecheck` type-checks without emitting.
