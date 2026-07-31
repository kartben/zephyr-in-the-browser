# Desktop bridge (uber bridge)

**Status:** shipped. Package: [`bridge/`](../bridge/). Page: **Settings** (top
bar) + Trace **Live board** + Network **Bridge network**.

One long-lived desktop process and **one WebSocket URL** for:

| Channel | Purpose |
| --- | --- |
| CTF | Live Trace from a real board (UART/USB-serial) |
| NET | Guest Ethernet via passt (same as the old net gateway) |
| GDB | Optional proxy to OpenOCD / J-Link / Espressif OpenOCD |

Configure the URL once under **Settings → Desktop bridge**. Trace and Network
reuse it. Deep link: `?bridge=ws://…`.

The process is meant to **stay up**: unplug the board, lose passt, refresh the
tab — reconnect; do not restart the daemon for routine events.

## Run it

### Native (recommended when you need USB serial)

```console
cd bridge && npm install && npm start
```

Works on macOS, Windows, and Linux. The TUI lists serial ports; with a single
port it auto-starts CTF. Press `g` for GDB against `localhost:3333`.

### Docker

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

Network (passt) works in Docker without any serial device.

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8740` | listen port |
| `TOKEN` | random | `?token=`; `none` disables auth |
| `BAUD` / `SERIAL` | `115200` / — | serial; auto-open path |
| `AUTO_SERIAL` | on | open the only port automatically |
| `DISABLE_NET` | — | `1` skips passt |
| `GDB_HOST` / `GDB_PORT` | `127.0.0.1` / `3333` | GDB proxy |
| `NO_TUI` | — | `1` for logs only (Docker default) |

## Page UI (no ELF required)

1. Settings → enable **Desktop bridge**, paste the URL, Connect.
2. Open **Trace** (shown when the bridge is enabled even with no guest image).
3. Live board shows ports / streaming status.
4. Optional: Network → **Bridge network**, restart guest for real uplink.

## Firmware

Same as before: CTF over UART/USB, not semihosting. Snippet
`-S hardware-tracing` plus a `zephyr,tracing-uart` overlay. See the older
[probe-bridge.md](probe-bridge.md) notes for Cortex-M vs ESP32.

## Wire protocol

Binary WebSocket messages: `u8 channel | payload…`

| `0x01` CTF | `0x02` GDB | `0x03` NET (one Ethernet frame) | `0x10` CTRL JSON |

Hello advertises `protocol: "zitb-bridge"` and `features: { ctf, gdb, net }`.

## Legacy

- [`gateway/`](../gateway/) remains the net-only image (`?net=` / Network URL).
- [`probe/`](../probe/) remains the CTF-only package; prefer `bridge/` going forward.
