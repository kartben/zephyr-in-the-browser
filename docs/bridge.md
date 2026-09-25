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
3. Debug → **Attach** drives the board through your GDB server (next section).
4. Bridge network is a **Simulator** feature: switch back, choose Network →
   **Bridge network**, restart the guest for real uplink. The connection is
   shared; the Trace panel is not seized while the Simulator runs.

**"timed out opening /dev/… — unplug and replug the board":** the USB serial
node is wedged, not busy. A CDC device pulled mid-transfer (ST-Link VCPs are
prone to it) leaves `open()` blocking in the kernel past `kill -9`, so nothing
on the host can reopen it — `screen` and `west espressif monitor` hang on it
too. Replug the cable. The daemon reports this instead of waiting, and the GDB
and network channels keep working while the port is out.

## Debug a real board

In **Live board** mode the Debug panel drives the physical board through the
bridge's GDB channel:

1. Run a GDB server against the board — OpenOCD, J-Link, pyOCD
   (`west debugserver` works). Default `127.0.0.1:3333`; override with
   `GDB_HOST` / `GDB_PORT`.
2. Debug panel → **Attach**. The daemon dials the server and relays RSP;
   attaching briefly halts the board, then the session resumes it.
3. Drop the ELF you flashed anywhere on the page for symbols, threads and
   call stacks. Without it you still get registers, memory and address
   breakpoints, with a register-layout picker.

Details the panel handles for you: OpenOCD's ack mode (until no-ack lands),
targets without `vCont` (bare `c`/`s` fallback), flash-resident code (`Z0`
failures retry as hardware `Z1` comparators), and adopting a session the TUI's
`g` key already opened (detach then leaves the TUI's proxy up). One page owns
the session at a time — a second tab is told it is busy. If the WebSocket
drops, the daemon keeps its TCP proxy; re-attach re-plants your breakpoints.

## Firmware

Do **not** use `CONFIG_TRACING_BACKEND_SEMIHOST` (that is for qemu). Keep
**CTF** so the Trace panel can decode the stream.

### Common (any board)

```
CONFIG_THREAD_NAME=y
CONFIG_TRACING=y
CONFIG_TRACING_CTF=y
CONFIG_TRACING_SYNC=y
```

Plus **one** backend:

| Backend | Kconfig | Notes |
| --- | --- | --- |
| UART CTF | `CONFIG_TRACING_BACKEND_UART=y` | Needs a free UART and `zephyr,tracing-uart` in DTS |
| USB CTF | `CONFIG_TRACING_BACKEND_USB=y` | Board must expose device USB |
| RAM | `CONFIG_TRACING_BACKEND_RAM=y` | Snapshot via GDB, not live follow |

A snippet is provided: `-S hardware-tracing` (UART CTF defaults). You still
need a board overlay that points `zephyr,tracing-uart` at a UART that is
**not** the console.

Example overlay sketch:

```dts
/ {
  chosen {
    zephyr,tracing-uart = &uart1;
  };
};

&uart1 {
  status = "okay";
  current-speed = <115200>;
};
```

If `CONFIG_TRACING_HANDLE_HOST_CMD=y`, the bridge sends `enable\r` when it
opens the port (same as Zephyr's `trace_capture_uart.py`).

For Debug-friendly builds, also set `CONFIG_DEBUG_THREAD_INFO=y` (and keep an
unstripped ELF).

### Cortex-M / ARM32

UART CTF + ST-Link/J-Link/CMSIS-DAP is the usual path. Stock OpenOCD or pyOCD
on `localhost:3333` can be attached from the TUI with `g` once you start
`west debugserver` (or equivalent).

### ESP32

Same CTF Kconfig. Prefer UART CTF over the USB-serial port your DevKit
already exposes. Use **Espressif OpenOCD** for GDB, not the Zephyr SDK
OpenOCD. Classic Xtensa ESP32 register maps are not wired into the in-page
Debug panel yet; RISC-V ESP32-C3/C6 are closer. Trace works regardless.

## Wire protocol

Binary WebSocket messages: `u8 channel | payload…`

| `0x01` CTF | `0x02` GDB | `0x03` NET (one Ethernet frame) | `0x10` CTRL JSON |

Hello advertises `protocol: "zitb-bridge"` and `features: {ctf,gdb,net}`.

## Security

Anyone with the URL can read your board's trace stream, talk to the debug
stub when GDB is attached, and send traffic from the bridge host's network
when Bridge network is on. Token auth is on by default. Do not expose the port
on the public internet without a tunnel you trust.
