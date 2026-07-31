# Desktop bridge

**Status:** shipped. Package: [`bridge/`](../bridge/) (Go). Page: top-bar
**mode switch** (Simulator · Live board) + **Settings** + Network
**Bridge network**.

One long-lived native process and **one WebSocket URL** for:

| Channel | Purpose |
| --- | --- |
| CTF | Live Trace from a real board (UART/USB-serial) |
| NET | Guest Ethernet via embedded [gvisor-tap-vsock](https://github.com/containers/gvisor-tap-vsock) (no passt, no Docker required) |
| GDB | Optional proxy to OpenOCD / J-Link / Espressif OpenOCD |

Configure the URL once under **Settings → Desktop bridge**. Trace and Network
reuse it. Deep link: `?bridge=ws://…` (opens the page in **Live board** mode;
bookmark `?mode=sim&bridge=…` for a Simulator session that only wants Bridge
network).

The process is meant to **stay up**: unplug the board, refresh the tab —
reconnect; do not restart the daemon for routine events.

## Run it

### Native (recommended)

Works on **macOS, Windows, and Linux** (Go 1.22+; toolchain auto-downloads):

```console
cd bridge && go run ./cmd/zephyr-bridge
```

Or build a binary:

```console
cd bridge && go build -o zephyr-bridge ./cmd/zephyr-bridge
./zephyr-bridge
```

The TUI lists serial ports; with a single port it auto-starts CTF. Press `g`
for GDB against `localhost:3333`. Net is on by default (gvisor userspace stack).

### Docker (optional)

```console
docker run --rm -p 8740:8740 ghcr.io/kartben/zephyr-in-the-browser/bridge
```

**USB serial and Docker:** Docker Desktop on macOS/Windows generally **cannot**
see USB serial adapters. Use native there. On Linux:

```console
docker run --rm -p 8740:8740 --device=/dev/ttyACM0 \
  -e SERIAL=/dev/ttyACM0 \
  ghcr.io/kartben/zephyr-in-the-browser/bridge
```

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8740` | listen port |
| `TOKEN` | random | `?token=`; `none` disables auth |
| `BAUD` / `SERIAL` | `115200` / — | serial; auto-open path |
| `AUTO_SERIAL` | on | open the only port automatically |
| `DISABLE_NET` | — | `1` skips the virtual network |
| `FORWARDS` | — | `hostPort:guestPort,…` into `192.0.2.1` |
| `GDB_HOST` / `GDB_PORT` | `127.0.0.1` / `3333` | GDB proxy |
| `NO_TUI` | — | `1` for logs only (Docker default) |

Guest addressing matches the in-page simulated LAN and `net-uplink.conf`:
DHCP (and static samples) use `192.0.2.1/24` with gateway `192.0.2.2`.
`192.0.2.254` NATs to the bridge host loopback.

## Page UI (no guest image required)

1. Flip the top-bar switch to **Live board** (the `?bridge=` deep link does
   this on its own). The stage walks through install / Connect; the URL lives
   under Settings.
2. Pick a serial port when the bridge lists one. Trace streams from the board.
3. Bridge network is a **Simulator** feature: switch back, choose Network →
   **Bridge network**, restart the guest for real uplink. The connection is
   shared; the Trace panel is not seized while the Simulator runs.

## Firmware

CTF over UART/USB, not semihosting. Snippet `-S hardware-tracing` plus a
`zephyr,tracing-uart` overlay. See [probe-bridge.md](probe-bridge.md) notes for
Cortex-M vs ESP32.

## Wire protocol

Binary WebSocket messages: `u8 channel | payload…`

| `0x01` CTF | `0x02` GDB | `0x03` NET (one Ethernet frame) | `0x10` CTRL JSON |

Hello advertises `protocol: "zitb-bridge"` and `features: {ctf,gdb,net}`.

## Legacy packages

- [`gateway/`](../gateway/) — older net-only passt image (Linux/Docker). Prefer
  this Go bridge.
- [`probe/`](../probe/) — older Node CTF-only package; prefer `bridge/`.
