# zephyr-in-the-browser gateway

Gives the browser-hosted Zephyr guest a **real network**. The
[web app](https://kartben.github.io/zephyr-in-the-browser/) tunnels the
guest's raw Ethernet frames here over a WebSocket; [passt](https://passt.top/)
turns them into ordinary sockets on this machine — real DHCP, DNS, TCP/UDP and
ICMP, no root, no TAP devices.

## Run it

```console
docker run --rm --security-opt seccomp=unconfined -p 8737:8737 ghcr.io/kartben/zephyr-in-the-browser/gateway
```

Copy the printed `ws://localhost:8737/?token=…` URL into the app's **Network
panel → Uplink**, or just open the printed deep link. Chrome/Firefox/Edge
connect to localhost directly; **Safari or a remote gateway need a `wss://`
URL** — add `-e TUNNEL=quick` and a free, account-less
`wss://….trycloudflare.com` URL is printed too.

The wire protocol is QEMU's stream-netdev framing (u32 big-endian length per
Ethernet frame, as a byte stream) — this proxy never parses a frame, it
authenticates, spawns **one passt per connection** (all guests share one
hardcoded MAC, so they must never share an L2 segment) and pipes bytes.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8737` / `0.0.0.0` | where to listen |
| `TOKEN` | random per start | `?token=` value; `none` disables auth |
| `MAX_CLIENTS` | `8` | concurrent guests |
| `PASST_DEFAULT_ARGS` | `-4 --mtu 1500` | replaces baseline passt flags (`--mtu 1500` is required — the browser ring drops frames over 1522 B) |
| `PASST_ARGS` | — | extra passt flags, e.g. `-t 4242` to forward a port into the guest |
| `TUNNEL` | — | `quick` = bundled cloudflared quick tunnel |
| `PAGES_URL` | the hosted app | base for the printed deep link |

Example — let the host reach the guest's `echo_server`:

```console
docker run --rm --security-opt seccomp=unconfined -p 8737:8737 -p 4242:4242 -e PASST_ARGS="-t 4242" ghcr.io/kartben/zephyr-in-the-browser/gateway
```

## Security

Anyone with the URL gets a NAT'd interface on this machine's network — treat
it as a secret. Token auth is on by default; quick-tunnel URLs die with the
process; inbound forwards are off unless you add them. Full notes, protocol
spec and alternative gateways:
[docs/net-gateway.md](../docs/net-gateway.md).

## Without Docker

`npm ci && node server.mjs` works on **Linux with passt installed** (it is in
Debian, Fedora, Alpine, Arch). passt does not run on macOS/Windows — use the
container there. `npm test` runs the proxy's tests against a fake passt, so
they pass anywhere.
