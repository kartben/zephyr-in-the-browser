# Zephyr in the Browser

The [Zephyr RTOS](https://zephyrproject.org/) shell running in a browser tab, on
top of [qemu-wasm](https://github.com/ktock/qemu-wasm) — QEMU compiled to
WebAssembly with Emscripten.

This is v1: a terminal UI and a clean integration seam. The emphasis is on the
seam being correct, not on features.

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

To run the real thing, put a qemu-wasm build in `public/qemu/` — see
[`public/qemu/README.md`](public/qemu/README.md) for the exact file list — and
restart the dev server. The app switches to the `qemu-wasm` backend on its own.

## Cross-origin isolation is not optional

xterm-pty runs the emulator off the main thread and does **blocking** stdin reads
with `Atomics.wait` on a `SharedArrayBuffer`; qemu-wasm is built with
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

Selection order: `VITE_PTY_BACKEND=mock|qemu`, else qemu when `public/qemu/`
contains a `.wasm`, else mock. The top-bar dropdown overrides it at runtime.

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
each carrying the QEMU argv and the artifact basename it needs. Two are defined:
`qemu_cortex_m3` (default, 32-bit ARMv7-M) and `qemu_riscv32`. Adding another is
a data change plus a matching qemu-wasm build.

qemu-wasm is not the pure interpreter it once was — it runs multi-threaded TCG
and JITs hot translation blocks into Wasm modules, falling back to TCI for cold
ones. It is still much slower than native QEMU, so a small 32-bit guest remains
the right default.

## Layout

```
src/
  backends/     PtyBackend seam: types, mock, qemu, selection
  components/
    XTerminal.tsx   owns xterm.js imperatively; mounted once, never re-renders
    TopBar.tsx      board + backend selectors, status pill, restart
    ui/             shadcn/ui primitives
  boards.ts     guest registry
public/qemu/    drop-in target for qemu-wasm artifacts (gitignored)
```

`XTerminal` is memoised and mounts on an empty dependency list: xterm renders
into DOM React does not manage, and re-creating it would drop the pty the backend
is attached to. Theme and sizing are handled inside the effect with `matchMedia`
and a `ResizeObserver` driving the fit addon, not through props.

## Not in v1

No virtual peripherals or Web API bridges, no multi-session management, no
persistence, no auth.

## Stack

Vite 8, React 19, TypeScript 7, Tailwind 4, shadcn/ui, `@xterm/xterm` 5.5 with
`@xterm/addon-fit`, and `xterm-pty`. xterm is held at 5.5 because that is the
peer range `xterm-pty@0.12` declares.
