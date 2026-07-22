# Zephyr in the Browser

The [Zephyr RTOS](https://zephyrproject.org/) shell running in a browser tab, on
top of [QEMU](https://www.qemu.org/) compiled to WebAssembly with Emscripten.
The Cortex-M machine uses upstream QEMU 10.1's interpreter; Cortex-A53 uses an
experimental WebAssembly JIT for hot guest code.

The browser UI includes the serial terminal, host-backed sensor controls,
host-backed GPIO with clickable buttons and live LED indicators, an editable
GNSS fix streamed as standard NMEA over UART, and a live framebuffer panel for
Zephyr's `qemu,ramfb` display driver. Each peripheral lives in its own
collapsible, dismissible panel.

## Run it

```console
npm install
npm run dev
```

That comes up on <http://localhost:5173> with the **mock backend** — a fake
Zephyr shell that prints a boot banner, echoes input and answers `help`,
`version`, `kernel version` and `clear`. It exists so the terminal wiring is
demonstrable without a 100 MB QEMU build, and it announces itself in the banner
so nobody mistakes it for a real boot.

To run the real thing, build the emulator and a guest image, then restart the dev
server:

```console
npm install
tools/build-qemu-wasm.sh       # emulator -> public/qemu/   (slow, containerised)
tools/build-zephyr-image.sh    # Cortex-M3 GNSS + shell + hello world
tools/build-zephyr-image.sh qemu_cortex_a53  # GNSS + display + hello world
npm run dev
```

Neither script needs a local Emscripten or Zephyr toolchain. The app switches to
the QEMU backend on its own once a `.wasm` is present, and you get the
actual Zephyr shell:

```
*** Booting Zephyr OS build v4.4.0-8956-gc5d81fa5d424 ***
uart:~$ kernel version
Zephyr version 4.4.99
uart:~$
```

Those artifacts are gitignored — the GPLv2 emulator and compiled guests are
build outputs, not source — so a fresh clone starts on the mock until you build
them. [`public/qemu/README.md`](public/qemu/README.md) covers the drop-in
contract, upstream/toolchain workarounds, and the patches used by the ARM and
AArch64 builds.

## Cross-origin isolation is not optional

xterm-pty runs the emulator off the main thread and does **blocking** stdin reads
with `Atomics.wait` on a `SharedArrayBuffer`; QEMU's Emscripten build uses
`-pthread -sPROXY_TO_PTHREAD=1` on top of that. `SharedArrayBuffer` is only
exposed to [cross-origin isolated](https://web.dev/coop-coep/) documents, which
means every response must carry:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The `crossOriginIsolation` plugin in [`vite.config.ts`](vite.config.ts) sets both
on the dev server and on `vite preview`. The QEMU backend also checks
`crossOriginIsolated` before it loads anything and fails with a readable message,
because the failure mode otherwise is a terminal that mounts fine and then hangs
forever on the first keystroke.

**Static hosts cannot do this.** GitHub Pages, plain S3 and similar serve fixed
headers you do not control, so a deploy there is not cross-origin isolated and
the QEMU backend will refuse to start. The workaround is
[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker): a service
worker that re-serves the page to itself with the headers attached. Add its
script to `index.html` before the app bundle. Hosts where you *can* set headers
directly (Netlify `_headers`, Vercel `headers`, Cloudflare Pages, any real web
server) do not need the shim.

## Choosing what runs

Two controls, and they are different kinds of thing:

- **Board** — the machine QEMU emulates.
- **App** — the program it boots. Cortex-M3 ships GNSS, Shell, and Hello World;
  Cortex-A53 ships GNSS, Display, and Hello World.
  `tools/build-zephyr-image.sh` builds them, and the ids there must match the
  `samples` listed per board in [`src/boards.ts`](src/boards.ts).
  Cortex-M3 only lists apps verified against its slower qemu-wasm TCI timing;
  Cortex-A53 is unaffected.

There is no backend selector. The mock exists so a checkout without an emulator
still runs, not as something worth choosing: QEMU is used whenever it is
available, and when it is not the app falls back on its own and says why in the
terminal.

### Booting your own ELF

Drop one anywhere on the window, or pick **Load your own ELF…** from the App
dropdown. It replaces the selected app; the board still chooses the *machine*, so
the ELF has to be built for it. The ✕ beside the picker goes back to a built-in.

Anything QEMU can boot with `-kernel` works — it does not have to be Zephyr.

The file is checked for ELF magic before anything else happens, so dropping the
wrong thing gives you a message rather than a guest that silently never boots.

An Emscripten module is single-shot per document, so swapping the image once
QEMU is running costs a page reload. The bytes are handed across it through
IndexedDB and deleted as soon as they are claimed — a one-shot buffer rather
than persistence, so a failed boot cannot trap the page in a reload loop.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` deploys on every push to `main`, and on demand.

The emulator is not in git, so the workflow pulls it from a release. Cut one,
then point the repo at it:

```console
$ tools/package-emulator.sh v1     # bundles public/qemu/ and creates the release
$ gh variable set EMULATOR_RELEASE --body v1
```

From then on every push ships the real emulator. Rebuilding it means re-running
`package-emulator.sh` with a new tag and updating the variable; the app itself
redeploys on push regardless.

With `EMULATOR_RELEASE` unset, pushes deploy the mock backend alone — about
750 kB, needs no cross-origin isolation, and a reasonable way to show the UI
without shipping an emulator. To try a different release without changing the
variable:

```console
$ gh workflow run pages.yml -f emulator_release=v2
```

Two things need doing once, by hand, in repository settings: Pages must be
enabled with **GitHub Actions** as the source, and the repo must be public
(Pages on a private repo needs a paid plan).

The emulator travels as a release asset rather than in git — it is a build
output, and large binaries in history are forever. `tools/package-emulator.sh`
bundles them as a single tarball because release assets are flat and
`public/qemu/` has a `zephyr/` subdirectory.

**GPL.** That binary is a build of QEMU, so publishing it carries a
corresponding-source obligation. It is satisfied by this repository being
public: the source is [qemu/qemu](https://github.com/qemu/qemu) and
[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm) at the revisions
`tools/build-qemu-wasm.sh` pins, plus the patches under `tools/`, and the release
notes say so.

### Why the page reloads itself once

GitHub Pages cannot send COOP/COEP, and without them there is no
`SharedArrayBuffer` and the qemu backend refuses to start. `coi-serviceworker`
(vendored in `public/`, MIT) works around it by re-serving the page to itself
with the headers attached, which costs one automatic reload on first visit. It
is a no-op where the headers already arrive from the server, so the dev server
is unaffected.

Verified end to end against a deliberately header-less static server: the
service worker alone is enough to reach `crossOriginIsolated === true` and boot
the guest. A host that can set headers directly — Cloudflare Pages, Netlify, any
real web server — does not need the shim at all.

## The backend seam

`PtyBackend` in [`src/backends/types.ts`](src/backends/types.ts) is the whole
contract:

```ts
interface PtyBackend {
  readonly id: 'mock' | 'qemu'
  readonly label: string
  readonly resetRequiresReload: boolean
  start(slave: Slave, opts: StartOptions): Promise<void>
  reset(): Promise<void>
}
```

`start` receives the xterm-pty `slave` and reports lifecycle through
`opts.onStatus`: `idle → loading → running → exited | error`. `opts.signal`
aborts when the terminal unmounts; backends must check it after each `await`,
since React StrictMode mounts effects twice in development.

Two implementations:

- [`mock.ts`](src/backends/mock.ts) — the fake shell. Leans on xterm-pty's
  default line discipline, so echo and line editing come for free.
- [`qemu.ts`](src/backends/qemu.ts) — loads the Emscripten artifacts from
  `public/qemu/` and wires `Module.pty` to the slave, following the loader shape
  in ktock/qemu-wasm's own example page.

Selection order: `VITE_PTY_BACKEND=mock|qemu`, else QEMU when the emulator is
actually being served (a startup `HEAD` request, so it cannot go stale), else
mock. There is no UI toggle; a QEMU start that fails before committing the
document falls back to the mock and says why in the terminal.

### Restarting

`resetRequiresReload` exists because an Emscripten module is single-shot per
document — `load.js` mutates a global, `PROXY_TO_PTHREAD` spawns workers bound to
that instance, and re-instantiating wedges rather than restarts. So the QEMU
backend validates everything it can (isolation, asset presence) *before* touching
any global, and only then commits the document to one instance. Until that commit
the button says "Restart" and remounts in place; after it, the button says
"Reload" and the only honest restart is a page reload.

## Guests

Boards live in [`src/boards.ts`](src/boards.ts), one entry per Zephyr QEMU target,
carrying the QEMU argv, the emulator artifact it needs, and the guest files to
inject. Adding one is a data change plus a Zephyr build.

Two machines are verified: `qemu_cortex_m3` for the interactive shell, host
sensors, and host GPIO, and `qemu_cortex_a53` for the architectural timer,
fw_cfg, and `qemu,ramfb`. Both expose a second PL011 UART backed by editable
browser GNSS data and ship Zephyr's stock `samples/drivers/gnss` sample. The
Cortex-A53 board defaults to the stock `samples/drivers/display` sample and
renders its framebuffer in its own collapsible panel. The Cortex-M3 shell image
adds Zephyr's `gpio` shell command against the `qemu,host-gpio` device, so
`gpio get host_gpio <pin>` reads a button the browser raised and `gpio set
host_gpio <pin> <0|1>` drives an LED it displays.

The build script produces separate `arm-softmmu` and `aarch64-softmmu`
artifacts. Cortex-M3 deliberately stays on upstream QEMU's TCG interpreter: the
experimental JIT is known to miscompile its timer path. Cortex-A53 uses the
wasm32 JIT, which interprets cold translation blocks and compiles hot ones into
small WebAssembly modules. A local 20-million-iteration guest benchmark measured
7.1 seconds with TCI and 1.1 seconds with JIT (about 6.5× faster); the display
sample's architectural timer and ramfb output were also verified. Set
`QEMU_AARCH64_ACCEL=tci` when building to select the slower upstream fallback.

## Layout

```
src/
  backends/     PtyBackend seam: types, mock, qemu, selection
  components/
    XTerminal.tsx   owns xterm.js imperatively; mounted once, never re-renders
    TopBar.tsx      board + app selectors, status pill, restart
    DisplayPanel.tsx live qemu,ramfb canvas; collapsible and dismissible
    GnssPanel.tsx   editable NMEA fix and browser geolocation control
    SensorPanel.tsx host sensor controls
    GpioPanel.tsx   host GPIO buttons (inputs) and LED indicators (outputs)
    PeripheralPanels.tsx shared floating stack for peripheral popups
    ui/             shadcn/ui primitives
  boards.ts     guest registry
  hostDisplay.ts qemu,ramfb export bridge
  hostGnss.ts   NMEA generator and emulated UART bridge
  hostGpio.ts   host-driven inputs and guest-driven outputs bridge
public/qemu/    drop-in target for qemu-wasm artifacts (gitignored)
```

`XTerminal` is memoised and mounts on an empty dependency list: xterm renders
into DOM React does not manage, and re-creating it would drop the pty the backend
is attached to. Theme and sizing are handled inside the effect with `matchMedia`
and a `ResizeObserver` driving the fit addon, not through props.

## Not in v1

No display input bridge, multi-session management, persistence, or auth. The
display bridge is framebuffer-only: keyboard input still goes to the serial
terminal, and there is no virtio mouse/tablet wiring yet.

## Stack

Vite 8, React 19, TypeScript 7, Tailwind 4, shadcn/ui, `@xterm/xterm` 5.5 with
`@xterm/addon-fit`, and `xterm-pty`. xterm is held at 5.5 because that is the
peer range `xterm-pty@0.12` declares.
