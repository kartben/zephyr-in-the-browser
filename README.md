# Zephyr in the Browser

**[▶ Try it live](https://kartben.github.io/zephyr-in-the-browser/)** — the [Zephyr RTOS](https://zephyrproject.org/) shell running in a browser tab, no hardware or install required.

It's [QEMU](https://www.qemu.org/) compiled to WebAssembly with Emscripten, emulating Cortex-M and Cortex-A53 boards. Alongside the serial terminal, the UI offers host-backed sensor and GPIO controls (clickable buttons, live LED indicators), an editable GNSS fix streamed over UART, and a framebuffer panel for Zephyr's display driver — each in its own floating panel.

## Quick start

```console
npm install
npm run dev
```

Open <http://localhost:5173>. You'll land on a **mock backend** — a fake shell that echoes input and answers a few commands — so the UI works out of the box without a ~100 MB QEMU build.

To boot real Zephyr, build the emulator and a guest image, then restart the dev server:

```console
tools/build-qemu-wasm.sh     # builds the emulator -> public/qemu/ (slow, containerised)
tools/build-zephyr-image.sh  # builds Cortex-M3 guest images
npm run dev
```

Both scripts run in containers, so no local Emscripten or Zephyr toolchain is needed. The app switches to QEMU automatically once it finds a build. See [public/qemu/README.md](public/qemu/README.md) for details.

## Choosing what runs

Pick a **Board** (the emulated machine) and an **App** (the program it boots) from the top bar. You can also drop your own ELF onto the window to boot it instead — anything QEMU can run with `-kernel` works, not just Zephyr.

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
