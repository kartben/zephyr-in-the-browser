# Internals

Every device here is a **bridge** between a browser API and a Zephyr driver.
The guest runs stock Zephyr wherever possible; what the page supplies is the
other end of the wire.

| Document | What it covers |
| --- | --- |
| [peripherals.md](peripherals.md) | How the browser-fed devices reach the guest: the `browser_bridge` shield, the vendored drivers behind snippets, and touch input |
| [pwm-leds.md](pwm-leds.md) | Spec: `pwm-leds` dock strip beside the PWM duty chart |
| [gpio-controller.md](gpio-controller.md) | Spec (Proposal B): claimed-pin GPIO table + `used by` reveal |
| [networking.md](networking.md) | Why the page *is* the LAN, and exactly what does and does not leave the tab |
| [virtio-bridge.md](virtio-bridge.md) | The generic virtio bridge, which lets a device model be TypeScript instead of QEMU C |
| [next-drivers.md](next-drivers.md) | The bridge shapes already proven here, and what to add next |
| [performance.md](performance.md) | Where the time goes — emulator build flags, bridge round-trip latency, and the experiment that settles each |
| [../public/qemu/README.md](../public/qemu/README.md) | The emulator itself: how it is built, what is patched into it, and its known limits |
| [deploying.md](deploying.md) | Cutting a release and deploying to GitHub Pages |
| [sample-annotations.md](sample-annotations.md) | Samples that explain themselves as they run — teaching popups from `@annotate` comments, and stopping the machine to read them |
| [sample-docs.md](sample-docs.md) | The mirrored Zephyr sample docs and their "Run in simulator" widget |
| [riscv32-plan.md](riscv32-plan.md) | `qemu_riscv32` board — plan and current wiring status |
| [debug-gdb-plan.md](debug-gdb-plan.md) | In-page debugging: QMP registers now, gdbstub next |

## Investigations

Closed out, and kept for the evidence rather than the conclusion — both cost
real time to chase, and the misleading part is worth recognising again:

- [a53-lvgl-stack.md](a53-lvgl-stack.md) — a guest stack overflow that looked
  convincingly like a wasm-JIT miscompilation.
- [audio-feasibility.md](audio-feasibility.md) — why audio did not go over
  virtio-sound.
- [tracing-feasibility.md](tracing-feasibility.md) — live CTF Gantt via
  Zephyr semihosting + an in-page port of `trace_viewer.py`.

## The page

Vite, React, TypeScript, Tailwind, shadcn/ui, and
[`xterm-pty`](https://github.com/mame/xterm-pty) for the terminal. `npm test`
runs the vitest suite — the network stack, the virtio device models and the
annotation protocol are covered — and `npm run typecheck` type-checks without
emitting. `python3 -m unittest discover -s tools` covers the annotation
extractor, which runs inside the Zephyr build container. All three run in CI on
every push.
