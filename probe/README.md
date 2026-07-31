# zephyr-in-the-browser probe bridge

Streams Zephyr **CTF tracing** from a real board into the app's **Trace**
panel over a WebSocket. Optionally proxies a local GDB server (OpenOCD,
J-Link, pyOCD, Espressif OpenOCD) for later Debug use.

The process is meant to **stay up**: unplugging the board only stops the
stream; plug it back in (or pick another port in the TUI) and continue.

## Quick start (native — best for USB)

```console
cd probe
npm install
npm start
```

Use the TUI to pick a serial port (↑↓, Enter). Paste the printed
`ws://localhost:8740/?token=…` URL into **Trace → Live board**, or open the
printed deep link.

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8740` / `0.0.0.0` | listen address |
| `TOKEN` | random | `?token=`; `none` disables auth |
| `BAUD` | `115200` | serial baud rate |
| `SERIAL` | — | auto-open this path at start (no TUI pick needed) |
| `GDB_HOST` / `GDB_PORT` | `127.0.0.1` / `3333` | target for the GDB proxy (`g` in the TUI) |
| `NO_TUI` | — | `1` logs only (Docker default) |
| `PAGES_URL` | GitHub Pages app | deep-link base |
| `MAX_CLIENTS` | `8` | concurrent browser tabs |

## Docker (Linux hosts with USB)

```console
docker run --rm -p 8740:8740 --device=/dev/ttyACM0 \
  -e SERIAL=/dev/ttyACM0 \
  ghcr.io/kartben/zephyr-in-the-browser/probe
```

Pass every serial device you care about with more `--device` flags, or use
`--privileged` in a trusted lab. Docker Desktop on macOS/Windows generally
cannot see USB serial — run native there.

## Firmware

Build with Zephyr CTF over UART (or USB), not semihosting. See
[docs/probe-bridge.md](../docs/probe-bridge.md) for Kconfig, a
`hardware-tracing` snippet, and notes for Cortex-M vs ESP32.

## Without the TUI

`NO_TUI=1 SERIAL=/dev/ttyACM0 npm start` — same WebSocket, status on stdout.

`npm test` exercises the proxy with a fake serial layer (no hardware).
