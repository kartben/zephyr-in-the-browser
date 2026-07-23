# Zephyr in the Browser

**[▶ Try it live](https://kartben.github.io/zephyr-in-the-browser/)** — the [Zephyr RTOS](https://zephyrproject.org/) shell running in a browser tab, no hardware or install required.

It's [QEMU](https://www.qemu.org/) compiled to WebAssembly with Emscripten, emulating Cortex-M and Cortex-A53 boards. Alongside the serial terminal, the UI offers host-backed sensor and GPIO controls (clickable buttons, live LED indicators), an editable GNSS fix streamed over UART, a framebuffer panel for Zephyr's display driver, and a sound panel that plays guest-generated PCM through the Web Audio API — each in its own floating panel.

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

The packaged apps live in [`tools/samples.manifest`](tools/samples.manifest), one line per board × app with ids matching [`src/boards.ts`](src/boards.ts); `tools/build-zephyr-image.sh` rebuilds them all. Cortex-M3 only lists apps verified against its slower qemu-wasm TCI timing (nothing that blocks on `k_sleep` in steady state); Cortex-A53 runs the wasm JIT and is unaffected.

## Sample docs with a "Run in simulator" button

`/docs/` serves a mirrored copy of the official Zephyr documentation page for
every packaged sample, with a **Run in simulator** button injected next to
"Browse source code on GitHub". The button opens the emulator in a
near-fullscreen dialog, pre-selecting the right board and app — a prototype of
what the widget could look like embedded in the upstream docs.

The pages live in `public/docs/` (committed) and are regenerated with:

```console
npm run docs:fetch   # re-mirrors from docs.zephyrproject.org/latest
```

The script ([tools/fetch-docs.mjs](tools/fetch-docs.mjs)) reads
`tools/samples.manifest`, mirrors each sample's page plus its CSS/JS/font
requisites, rewrites links (pages inside the subset stay local, everything
else points at the live docs), and injects the widget
([tools/docs-widget/](tools/docs-widget)) — deliberately framework-free JS/CSS
so it could later ship as a Sphinx extension. The pages also load
`coi-serviceworker.js`: the emulator needs `SharedArrayBuffer`, which only
exists when the *top-level* document is cross-origin isolated, so the docs
pages have to opt in themselves for the embedded emulator to boot on GitHub
Pages. Restart the dev server after regenerating — Vite caches the `public/`
file list at startup.

## The browser_bridge shield

The browser-fed peripherals — GNSS UART, host sensor, host GPIO, host audio out, and the browser-sized ramfb — reach the guest through a Zephyr shield, **`browser_bridge`** ([zephyr-module/boards/shields/browser_bridge/](zephyr-module/boards/shields/browser_bridge)), applied to every packaged build. Its overlays alias the host sensor as `accel0`, `temp0`/`ambient-temp0`, `light0`, `humidity0` and `press0`, so stock Zephyr sensor samples build unmodified against browser-fed readings. Building any app against the browser machines is just:

```console
west build -b qemu_cortex_m3 <app> -- -DZEPHYR_EXTRA_MODULES=<repo>/zephyr-module -DSHIELD=browser_bridge
```

Each machine instantiates the devices where the overlays expect them: the Stellaris patches in `tools/qemu-patches/` put the sensor at 0x40060000, the GPIO controller at 0x40061000 and the audio out at 0x40062000; the virt patches in `tools/qemu-jit-patches/` put the sensor at 0x090c0000 and the audio out at 0x090d0000.

## Deploying

Pushes to `main` deploy to GitHub Pages. The emulator binary isn't checked into git, so publish it once as a release and point the repo at it:

```console
tools/package-emulator.sh v1
gh variable set EMULATOR_RELEASE --body v1
```

Without that variable, Pages ships the mock backend only.

A couple of details are handled for you: static hosts can't set the cross-origin isolation headers QEMU needs, so the deployed build uses [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) to add them client-side. And since the emulator is GPLv2-licensed QEMU, this repo being public — with release notes pointing at the pinned sources — satisfies the corresponding-source requirement.

## Stack

Vite, React, TypeScript, Tailwind, shadcn/ui, and [`xterm-pty`](https://github.com/mame/xterm-pty) for the terminal.
