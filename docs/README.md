# Internals

Every device here is a **bridge** between a browser API and a Zephyr driver.
The guest runs stock Zephyr wherever possible; what the page supplies is the
other end of the wire.

| Document | What it covers |
| --- | --- |
| [peripherals.md](peripherals.md) | How the browser-fed devices reach the guest: the `browser_bridge` shield, the vendored drivers behind snippets, and touch input |
| [networking.md](networking.md) | Why the page *is* the LAN, and exactly what does and does not leave the tab |
| [virtio-bridge.md](virtio-bridge.md) | The generic virtio bridge, which lets a device model be TypeScript instead of QEMU C |
| [next-drivers.md](next-drivers.md) | The bridge shapes already proven here, and what to add next |
| [../public/qemu/README.md](../public/qemu/README.md) | The emulator itself: how it is built, what is patched into it, and its known limits |
| [deploying.md](deploying.md) | Cutting a release and deploying to GitHub Pages |
| [sample-docs.md](sample-docs.md) | The mirrored Zephyr sample docs and their "Run in simulator" widget |

## Investigations

Closed out, and kept for the evidence rather than the conclusion — both cost
real time to chase, and the misleading part is worth recognising again:

- [a53-lvgl-stack.md](a53-lvgl-stack.md) — a guest stack overflow that looked
  convincingly like a wasm-JIT miscompilation.
- [audio-feasibility.md](audio-feasibility.md) — why audio did not go over
  virtio-sound.
- [gdb-feasibility.md](gdb-feasibility.md) — why a debugger is feasible (QEMU's
  gdbstub over a browser chardev) and why shipping GDB-as-Wasm is not.

## The page

Vite, React, TypeScript, Tailwind, shadcn/ui, and
[`xterm-pty`](https://github.com/mame/xterm-pty) for the terminal. `npm test`
runs the vitest suite — the network stack and the virtio device models are
covered — and `npm run typecheck` type-checks without emitting. Both run in CI
on every push.
