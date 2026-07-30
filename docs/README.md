# Internals

Every device here is a **bridge** between a browser API and a Zephyr driver.
The guest runs stock Zephyr wherever possible; what the page supplies is the
other end of the wire.

| Document | What it covers |
| --- | --- |
| [focus.md](focus.md) | Cortex-A53 is the primary board; with/without tracing sample variants |
| [peripherals.md](peripherals.md) | How the browser-fed devices reach the guest: the `browser_bridge` shield, the vendored drivers behind snippets, and touch input |
| [pwm-leds.md](pwm-leds.md) | Spec: `pwm-leds` dock strip beside the PWM duty chart |
| [gpio-controller.md](gpio-controller.md) | Spec (Proposal B): claimed-pin GPIO table + `used by` reveal |
| [can-bus.md](can-bus.md) | The CAN bus class, where the page models *the rest of the network* — spec, plus what iteration 1 changed about it |
| [networking.md](networking.md) | Why the page *is* the LAN, and exactly what does and does not leave the tab |
| [net-gateway.md](net-gateway.md) | The opt-in uplink: guest frames over a WebSocket to a self-hosted passt gateway — quick start, tunnels, security, the wire protocol |
| [bluetooth.md](bluetooth.md) | Zephyr host + in-page Bumble controller over `hci0` / H:4 |
| [bluetooth-peer-ui-spec.md](bluetooth-peer-ui-spec.md) | Draft: select-one peer inspector for HRM / advertiser / scanner |
| [virtio-bridge.md](virtio-bridge.md) | The generic virtio bridge, which lets a device model be TypeScript instead of QEMU C |
| [next-drivers.md](next-drivers.md) | The bridge shapes already proven here, and what to add next |
| [performance.md](performance.md) | Where the time goes — emulator build flags, bridge round-trip latency, and the experiment that settles each |
| [../public/qemu/README.md](../public/qemu/README.md) | The emulator itself: how it is built, what is patched into it, and its known limits |
| [deploying.md](deploying.md) | Cutting a release and deploying to GitHub Pages |
| [tours.md](tours.md) | Guided tours — a Markdown DSL that breaks anywhere in a stock sample and shows what it finds |
| [sample-docs.md](sample-docs.md) | The mirrored Zephyr sample docs and their "Run in simulator" widget |
| [riscv32-plan.md](riscv32-plan.md) | `qemu_riscv32` board — plan and current wiring status |
| [trace-networking-plan.md](trace-networking-plan.md) | Trace panel **Networking** tab from Zephyr socket / `net_*` CTF — the socket swimlanes shipped; the connection ribbon and cross-panel linking did not |
| [cpu-power-states.md](cpu-power-states.md) | CPU suspend states in the Trace panel from PM CTF, ranked by the devicetree — the CPU lane group, the Power tab, the sample and the guest overlay; visual language set by [the mockup](cpu-power-mockup.html) |

## Shipped plans

Written as proposals and kept as the design record, because the argument is why
the code is shaped the way it is. Each opens with a status line saying what
actually landed — including, in one case, a rule that was argued for and then
deliberately reversed:

- [debug-gdb-plan.md](debug-gdb-plan.md) — in-page debugging over QEMU's
  gdbstub: the second browser chardev, the QMP fallback, breakpoints, memory,
  Zephyr threads and the call stack. Still open: disassembly and source lines.
- [debug-panel-plan.md](debug-panel-plan.md) — why debug left the TopBar
  popover for a dockable panel, and how setting a breakpoint stopped requiring
  a pause first.

## Investigations

Closed out, and kept for the evidence rather than the conclusion — both cost
real time to chase, and the misleading part is worth recognising again:

- [a53-lvgl-stack.md](a53-lvgl-stack.md) — a guest stack overflow that looked
  convincingly like a wasm-JIT miscompilation.
- [audio-feasibility.md](audio-feasibility.md) — why audio did not go over
  virtio-sound.
- [bluetooth-bumble-feasibility.md](bluetooth-bumble-feasibility.md) — why
  Bumble Hive is a peer catalog, not the controller, and how HCI-over-browser
  chardev + an in-page Bumble controller would look.
- [tracing-feasibility.md](tracing-feasibility.md) — live CTF Gantt via
  Zephyr semihosting + an in-page port of `trace_viewer.py`.

## The page

Vite, React, TypeScript, Tailwind, shadcn/ui, and
[`xterm-pty`](https://github.com/mame/xterm-pty) for the terminal. `npm test`
runs the vitest suite — the network stack, the virtio device models, the DWARF
readers and the tour DSL are covered — and `npm run typecheck` type-checks
without emitting. Both run in CI on every push.
