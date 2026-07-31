# Probe bridge: Trace from a real board

**Status:** superseded. The Node daemon in [`probe/`](../probe/) is legacy —
the Go desktop bridge ([`bridge/`](../bridge/), [bridge.md](bridge.md)) carries
CTF, network, and GDB over one WebSocket, and the page side is the **Live
board** session mode (`src/components/LiveBoardHome.tsx`,
`src/probe/client.ts`). The in-page Debug follow-up this doc promised has
shipped: the Debug panel attaches to a real board through the bridge (see
[bridge.md](bridge.md), "Debug a real board"). The firmware notes below still
apply.

Stream Zephyr **CTF** from hardware into the same Trace panel the guest uses.

```
Zephyr (CTF UART/USB) ─ serial ─ probe daemon ─ WebSocket ⇉ TraceReader ─ Trace panel
OpenOCD / J-Link GDB  ─ TCP    ─ (optional) ── WebSocket GDB channel
```

## 1. Run the bridge

**Native (recommended for USB):**

```console
cd probe && npm install && npm start
```

The TUI lists serial ports. ↑↓ selects, Enter starts CTF streaming. The process
**does not exit** when you unplug the board; plug it back in or pick another
port. `q` quits.

**Linux Docker:**

```console
docker run --rm -p 8740:8740 --device=/dev/ttyACM0 \
  -e SERIAL=/dev/ttyACM0 \
  ghcr.io/kartben/zephyr-in-the-browser/probe
```

Docker Desktop on macOS/Windows usually cannot see USB serial. Use native
there.

Paste the printed `ws://localhost:8740/?token=…` into **Trace → Live board →
Probe bridge**, or open the deep link (`?probe=`).

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8740` | listen port |
| `TOKEN` | random | `?token=`; `none` disables auth |
| `BAUD` | `115200` | serial baud |
| `SERIAL` | — | auto-open this path at start |
| `GDB_HOST` / `GDB_PORT` | `127.0.0.1` / `3333` | GDB proxy target (TUI `g`) |
| `NO_TUI` | — | `1` for logs only (Docker default) |
| `MAX_CLIENTS` | `8` | concurrent tabs |

## 2. Firmware configuration

Do **not** use `CONFIG_TRACING_BACKEND_SEMIHOST` (that is for qemu). Keep
**CTF** so this Trace panel can decode the stream.

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

## 3. Wire protocol

Each WebSocket **binary** message is one frame: `u8 channel | payload…`.

| Channel | Direction | Payload |
| --- | --- | --- |
| `0x01` CTF | daemon → page | raw Zephyr CTF bytes |
| `0x02` GDB | bidirectional | GDB RSP bytes |
| `0x10` CTRL | either way | UTF-8 JSON |

Control messages include `hello`, `ports`, `select-serial`, `serial-status`,
`gdb-attach`, `gdb-status`. Auth is `?token=` (same close codes as the net
gateway: `4001` unauthorized, `4002` full).

## 4. Security

Anyone with the URL can read your board's trace stream and, if GDB is
attached, talk to the debug stub. Token auth is on by default. Do not expose
the port on the public internet without a tunnel you trust.
