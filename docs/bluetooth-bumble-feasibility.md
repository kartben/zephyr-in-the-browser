# Bluetooth in the browser: Bumble / Hive feasibility

The question: can [Bumble Hive](https://google.github.io/bumble/hive/index.html)
give this project a Bluetooth peripheral the way Ethernet and CAN already give
it a network?

**Verdict: yes for Bumble as a virtual controller; no for embedding Hive as
the primary path.** Hive is a useful *peer catalog* once we own an in-page HCI
controller. The bridge shape is already proven (bidirectional browser chardev
+ Zephyr's stock H:4 driver). The cost is real — Pyodide weight, a QEMU
chardev slot, and BT sample packaging — but nothing invents a fourth bridge
shape.

**Status (implementation started):** `hci0` chardev patches, A53/RISC-V UART
wiring, `bt-hci-uart` snippet, `bt_peripheral` sample packaging, page bridge +
Bumble vendor layout, and dock row are in tree. See [`bluetooth.md`](bluetooth.md).
A qemu-wasm rebuild (feature `"hci"`) and `tools/vendor-bumble.sh` are still
required before the end-to-end demo runs. Hive WebSocket peers remain a
follow-up.

## What Hive actually is

Hive is **not** a Bluetooth controller you drop into a page. It is a set of
Bumble apps and virtual devices (Scanner, Speaker, Heart Rate Monitor) that
run via **Pyodide** and speak HCI to *someone else* over a **WebSocket** —
typically Android Emulator `netsimd`, or `bumble-hci-bridge` in front of a USB
dongle.

So "integrate Hive" without a controller on *our* side only produces empty
WebSocket clients. The piece that belongs in this repo is the other end of
that pipe: a **virtual controller** the Zephyr guest can use as its radio,
with the page playing the rest of the air the way [`src/net/`](../src/net)
plays the LAN and [`src/can/`](../src/can) plays the bus.

Bumble already ships that controller. Hive is the optional peer UI on top.

## Roles that fit this project

| Role | Who | Why |
| --- | --- | --- |
| Bluetooth **Host** (apps, GATT, GAP) | Zephyr guest | Stock `samples/bluetooth/*`, shell `bt` commands, unmodified drivers |
| Bluetooth **Controller** (HCI, LL) | Bumble in the page | Virtual controller + LocalLink; no silicon, no SoftDevice on qemu |
| Peer devices / tools | Hive apps *or* small in-page Bumble Devices | Scanner, HRM, Speaker on the same LocalLink / RemoteLink room |

Flipping the roles (Zephyr as controller via `hci_uart`, Hive as host) fails
here: qemu boards have no on-chip radio for Zephyr's controller to drive.
Zephyr-as-host + external HCI is the path Zephyr already documents for
emulators (`zephyr,bt-hci-uart`, H:4).

## Shape (reuse, don't invent)

Two existing shapes cover it. Neither needs virtio-bluetooth (the virtio ID
exists only as comment noise in our SPI patches).

### 1. HCI pipe — extend browser chardev

[`chardev-browser`](../tools/qemu-jit-patches/0014-chardev-add-browser-backed-monitor-channel.patch)
already carries bidirectional bytes for `mon0` / `gdb0`
([`src/debug/browserChardev.ts`](../src/debug/browserChardev.ts)). Add a third
slot (`hci0`) and wire it to a UART the guest binds as HCI:

```
-chardev browser,id=hci0 -serial chardev:hci0
```

Guest side is stock Zephyr:

```dts
&uartN {
  status = "okay";
  bt_hci_uart: bt_hci_uart {
    compatible = "zephyr,bt-hci-uart";
    status = "okay";
  };
};

/ {
  chosen {
    zephyr,bt-hci = &bt_hci_uart;
  };
};
```

```
CONFIG_BT=y
CONFIG_BT_HCI=y
CONFIG_BT_CTLR=n
```

GNSS UART is the wrong template to copy wholesale: it is host→guest only
(NMEA feed). HCI needs the monitor/gdb rings. A dedicated `qemu-browser-hci.c`
clone of GNSS would re-pay the unidirectional lesson; extending the named-slot
chardev is the smaller patch.

Flow control and baud are soft here — the "UART" is a ring, not a wire. Zephyr's
H:4 driver still wants a UART that can interrupt; PL011 / Stellaris UART
frontends already do. Hardware RTS/CTS is not available in-tab and is not
required for a virtual pipe if the rings are large enough for ACL bursts
(bump `BROWSER_OUT_SIZE` / in-ring if needed; HCI commands are small, ACL less
so).

### 2. Medium — "the page is the air"

Mirror networking and CAN: once HCI bytes reach the page, a Bumble
`Controller` on a `LocalLink` owns advertising, scanning, and ACL between
peers. Dock surface shows what crossed the air (adv reports, connections,
GATT traffic) the way the Network panel shows frames.

Optional Hive integration is then a **WebSocket HCI server** (or Bumble
RemoteLink room) that Hive's Speaker / HRM / Scanner pages point at — same
controller, extra peers. First cut does not need that; an in-page virtual HRM
or scanner built on the same LocalLink is enough to demo
`samples/bluetooth/peripheral_hr` and `central_hr`.

## What is *not* the path

| Tempting option | Why not |
| --- | --- |
| iframe Hive as the Bluetooth panel | Hive has no radio of its own; it waits on an external WS controller |
| BlueZ / Linux VHCI in qemu-wasm | No host kernel HCI; wasm has no VHCI |
| Zephyr SoftDevice / LL on qemu | No radio model; controller belongs in the page |
| virtio-bluetooth | No Zephyr guest driver here; host backend still needed; chardev HCI is stock |
| Web Bluetooth API as the controller | Browser Web Bluetooth is a *host* API (central-ish), not an HCI controller you can attach Zephyr to; also permission-gated and not a full stack |

Opt-in uplink later (real dongle via local `bumble-hci-bridge`, or Android
`netsimd`) is the same pattern as the networking passt idea: sandbox in-tab by
default, helper daemon when you want real RF.

## Cost and risks

**Must pay**

1. **QEMU patch** — third `chardev-browser` slot (`hci0`) + machine wiring so a
   guest UART is backed by it (or `-serial chardev:hci0` on virt). Touches the
   same patch series as monitor/gdb; needs a wasm rebuild.
2. **Guest packaging** — `browser_bridge` overlay / snippet for
   `zephyr,bt-hci-uart`, conf fragment, `tools/samples.manifest` entries for a
   small BLE set (`peripheral`, `peripheral_hr`, `beacon`, shell `CONFIG_BT_SHELL`).
3. **Page controller** — load Bumble under Pyodide *or* a thin TypeScript HCI
   controller. Bumble is the honest choice for correctness (full virtual
   controller + LocalLink); Pyodide is a large download and cold-start cost,
   so gate it behind the Bluetooth sample / dock open, not every shell boot.
4. **Dock** — Bluetooth class row: power/advertising state, peer list, optional
   "open Hive peer" link with the WebSocket URL filled in.

**Risks**

- **HCI timing under TCI (Cortex-M3).** BLE host stacks assume a responsive
  controller. The interpreted M3 + 20 ms chardev poll may be too slow for
  connection events; ship first on **Cortex-A53 / RISC-V** (JIT) and treat M3
  as best-effort.
- **Pyodide size.** Expect multi‑MB before the first HCI Reset completes.
  Lazy-load; consider a minimal TS controller later if Bumble is only used as
  a peer factory.
- **H:4 framing bugs.** Easy to desync on partial reads; reuse Bumble's
  packetization on the page side and feed whole HCI packets into the ring
  when possible.
- **License / provenance.** Bumble is Apache-2.0; loading from CDN vs vendoring
  a wheel under `public/` is a packaging choice, not a blocker.

## Suggested first cut

1. Extend `chardev-browser` with `hci0`; expose feed/drain like monitor/gdb.
2. Snippet + shield wiring for `zephyr,bt-hci-uart` on A53; package
   `samples/bluetooth/peripheral` (or beacon) and enable `CONFIG_BT_SHELL` on
   a dedicated image — not the default shell, to keep everyday downloads lean.
3. Page: Pyodide + Bumble `Controller` on `LocalLink`; bridge HCI rings ↔
   controller transport (in-process style: page parses H:4, calls into
   Bumble).
4. Dock: advertising on/off, one virtual central that connects and lists GATT
   services.
5. **Follow-up:** WebSocket endpoint so Hive's Heart Rate Monitor / Scanner
   can join the same air; optional `bumble-hci-bridge` uplink for a real
   dongle.

## When to revisit

- If Zephyr gains a usable virtio-bluetooth (or HCI-over-virtio) path *and*
  we want to drop the UART fiction — still need the page-side controller, so
  the medium half of this plan stays.
- If someone lands a small pure-JS HCI controller good enough for BLE
  peripheral demos, Pyodide becomes optional rather than load-bearing.

## Sources

- [Bumble Hive](https://google.github.io/bumble/hive/index.html)
- [Bumble overview](https://google.github.io/bumble/)
- [Zephyr HCI UART / `zephyr,bt-hci-uart`](https://docs.zephyrproject.org/latest/connectivity/bluetooth/bluetooth-tools.html)
- In-tree parallels: [networking.md](networking.md), [can-bus.md](can-bus.md),
  GNSS / browser chardev patches under `tools/qemu-*-patches/`
