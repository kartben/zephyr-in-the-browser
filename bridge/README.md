# zephyr-in-the-browser desktop bridge

One WebSocket for **CTF** (live Trace), **NET** (passt uplink), and optional
**GDB**. Configure once in the app **Settings** menu.

## Native (best for USB)

```console
npm install && npm start
```

## Docker

```console
docker run --rm -p 8740:8740 ghcr.io/kartben/zephyr-in-the-browser/bridge
```

USB serial: Linux only with `--device=/dev/ttyACM0 -e SERIAL=…`. Docker Desktop
on macOS/Windows cannot see serial adapters reliably — use native there.

Full docs: [docs/bridge.md](../docs/bridge.md).
