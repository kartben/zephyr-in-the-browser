# zephyr-in-the-browser desktop bridge (Go)

One native binary for **CTF** (live Trace), **NET** (gvisor-tap-vsock), and
optional **GDB**. No Node, no passt, no Docker required on macOS / Windows /
Linux.

```console
cd bridge && go run ./cmd/zephyr-bridge
```

Or build once:

```console
cd bridge && go build -o zephyr-bridge ./cmd/zephyr-bridge
./zephyr-bridge
```

Paste the printed WebSocket URL into **Settings → Desktop bridge**.

## Docker (optional)

```console
docker run --rm -p 8740:8740 ghcr.io/kartben/zephyr-in-the-browser/bridge
```

USB serial through Docker still needs Linux `--device`. Prefer the native binary
for serial on macOS / Windows.

## Env

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8740` | listen port |
| `TOKEN` | random | `?token=`; `none` disables auth |
| `BAUD` / `SERIAL` | `115200` / — | serial; auto-open path |
| `AUTO_SERIAL` | on | open the only port automatically |
| `DISABLE_NET` | — | `1` skips the virtual network |
| `FORWARDS` | — | `hostPort:guestPort,…` → `127.0.0.1:host → 192.168.127.2:guest` |
| `GDB_HOST` / `GDB_PORT` | `127.0.0.1` / `3333` | GDB proxy |
| `NO_TUI` | — | `1` for logs only (Docker default) |

Guest DHCP is typically `192.168.127.2/24` via `192.168.127.1`; `host.containers.internal` / `192.168.127.254` reaches the bridge host loopback.
