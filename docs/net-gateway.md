# Net uplink gateway: real internet for the guest

**Status:** shipped. The web-app side is `src/net/uplink.ts` + the Uplink
section of the Network panel; the gateway is [`gateway/`](../gateway/),
published as `ghcr.io/kartben/zephyr-in-the-browser/gateway`. The in-page
sandbox ([networking.md](networking.md)) stays the default.

The sandbox's ceiling is structural: a browser page has no raw sockets, so
HTTPS, arbitrary TCP/UDP and real ICMP can never work in-page. The uplink
removes the ceiling by moving the other end of the guest's Ethernet cable out
of the tab: frames travel over a WebSocket to a small gateway you run, where
[passt](https://passt.top/) — the unprivileged user-mode network layer used by
podman — translates L2 frames into ordinary L4 sockets. No TAP devices, no
root, no kernel modules; DHCP, DNS, ARP and NDP are served by passt itself.

```
Zephyr driver ─ virtio-net ─ browser netdev rings ─ hostNet.ts ─ WebSocket ⇉
  ⇉ gateway proxy (Node) ─ unix socket ─ passt ─ real sockets on the gateway host
```

## 1. Quick start

Run the gateway (any machine with Docker — including macOS/Windows, where the
container hides passt's Linux-only nature):

```console
docker run --rm --security-opt seccomp=unconfined -p 8737:8737 ghcr.io/kartben/zephyr-in-the-browser/gateway
```

(`--security-opt seccomp=unconfined` is required by **passt's own sandbox**:
it isolates itself with user namespaces and `pivot_root`, which Docker's
default seccomp profile forbids. The trade is Docker's generic syscall filter
for passt's stricter one — empty filesystem, no capabilities, a dedicated
seccomp filter per process. Without the flag the gateway exits immediately
with this exact instruction.)

It prints a ready-to-paste WebSocket URL and a deep link:

```
[gw] listening on 0.0.0.0:8737 (auth: token)
[gw]   WebSocket : ws://localhost:8737/?token=ab12…
[gw]   Health    : http://localhost:8737/healthz
[gw]   Open the app with it: https://kartben.github.io/zephyr-in-the-browser/?net=ws%3A%2F%2Flocalhost%3A8737%2F%3Ftoken%3Dab12…
```

Then either open the deep link, or in the app: **Network panel → Uplink →
Gateway**, paste the URL, and restart the emulator (⟳). Boot the `dhcp`
sample and watch the capture: real DHCP from passt (the guest typically leases
a mirror of the container's address, e.g. `172.17.0.x`). `http_get` fetches
from the actual internet; `net ping 8.8.8.8` genuinely round-trips.

The mode and URL persist in `localStorage` under `zephyr.net`. A `?net=`
query param overrides both for the session: `?net=sim` forces the sandbox,
`?net=<url-encoded ws(s) URL>` forces the uplink — that's what the printed
deep link is.

## 2. Tunnels: getting a `wss://` URL

The deployed app is served over https, and browsers allow plain `ws://` from
an https page **only toward loopback** — and Safari not even there. So:

| You run the gateway… | Browser | URL to use |
| --- | --- | --- |
| on the same machine | Chrome / Firefox / Edge | `ws://localhost:8737/?token=…` works as-is |
| on the same machine | Safari | needs `wss://` — use a tunnel |
| anywhere else (server, classroom) | all | needs `wss://` — use a tunnel |

The easiest tunnel is bundled. cloudflared **quick tunnels** are free,
account-less and WebSocket-capable:

```console
docker run --rm --security-opt seccomp=unconfined -p 8737:8737 -e TUNNEL=quick ghcr.io/kartben/zephyr-in-the-browser/gateway
```

which additionally prints:

```
[gw]   Tunnel    : wss://random-words.trycloudflare.com/?token=ab12…
```

Alternatives, if you'd rather not use the bundled binary:

| Tool | Command | Notes |
| --- | --- | --- |
| cloudflared (sidecar) | `docker run --rm --network container:<gw> cloudflare/cloudflared tunnel --no-autoupdate --url http://localhost:8737` | same quick tunnel, official image |
| ngrok | `ngrok http 8737` | needs a (free) account + authtoken; use the printed `https://` host as `wss://` |
| Tailscale | `tailscale serve 8737` (or `funnel` for public) | great when the gateway machine is already on your tailnet |

Quick-tunnel URLs are ephemeral by design — they die with the process, which
for a "give my browser guest internet for an hour" tool is a feature.

## 3. Security

**Treat the printed URL as a secret.** Anyone holding it gets a NAT'd network
interface on the gateway's host — outbound TCP/UDP/ICMP as that machine.

- **Token auth is on by default**: a random token is generated at startup and
  embedded in the printed URLs (`?token=…`). Set `TOKEN=<value>` to pin it, or
  `TOKEN=none` to disable (loopback-only setups). A wrong token is closed
  with WebSocket code `4001` after the handshake, so the panel can say why.
- **One passt per connection.** Every zephyr-in-the-browser guest ships the
  same MAC (`02:00:00:00:00:01`), so clients must never share an L2 segment;
  each WebSocket gets its own passt process (`--one-off`: it exits with its
  connection). `MAX_CLIENTS` (default 8) caps concurrency; excess connections
  close with `4002`.
- **Inbound port forwards are off by default** — nothing on the gateway host
  reaches the guest unless you pass `PASST_ARGS="-t <port>"`.
- Guests can reach services listening on the gateway host (that is the
  point). If they must not reach its loopback-bound services, add
  `PASST_ARGS="--no-map-gw"`.
- The token rides in the URL query string; over `wss://` it is encrypted in
  transit but may land in proxy/server logs. Rotate by restarting.

## 4. How it works

- The `browser` netdev rings
  ([tools/qemu-patches/0008](../tools/qemu-patches/0008-net-add-browser-netdev-backend.patch))
  are unchanged — uplink vs sandbox is decided entirely in
  [`src/hostNet.ts`](../src/hostNet.ts), which hands drained frames to either
  the in-page `NetStack` or a `UplinkSink`
  ([`src/net/uplink.ts`](../src/net/uplink.ts)). That is also why capture,
  throughput, impairments and `.pcap` export work identically in both modes.
- While the socket is not open, guest frames are **dropped and counted** (the
  panel's uplink counters show it) — a transparent bridge, not a queue; DHCP
  and TCP retransmit. The wire's carrier itself stays up: Zephyr's
  `eth_virtio_net` driver has no link-status handling, so a socket-driven
  carrier flip could neither inform it nor safely force a re-lease.
- The gateway proxy ([`gateway/server.mjs`](../gateway/server.mjs))
  authenticates, spawns `passt --foreground --one-off --socket <path>` per
  connection, and pipes bytes both ways. It never parses a frame.
- passt answers the guest's DHCP itself (mirroring the container's address),
  proxies ARP/NDP and DNS, and terminates TCP/UDP/ICMP as plain sockets.
- The panel's IP/gateway/DNS readouts in uplink mode come from passively
  sniffing the DHCP exchange ([`src/net/sniff.ts`](../src/net/sniff.ts)).
- `--mtu 1500` is in the default passt flags and is **load-bearing**: the
  browser-side ring drops frames over 1522 bytes
  (`RING_MAX_FRAME`, [`src/net/ringCodec.ts`](../src/net/ringCodec.ts)), and
  passt's default MTU of 65520 would stall every large TCP transfer.

### Gateway environment variables

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8737` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `TOKEN` | random hex | `?token=` value; `none` disables auth |
| `MAX_CLIENTS` | `8` | concurrent connections; excess closed `4002` |
| `PASST_DEFAULT_ARGS` | `-4 --mtu 1500` | replaces the baseline passt flags |
| `PASST_ARGS` | — | appended after the defaults (e.g. `-t 4242`) |
| `TUNNEL` | — | `quick` starts the bundled cloudflared quick tunnel |
| `PAGES_URL` | the GitHub Pages app | base for the printed `?net=` deep link |
| `PASST_BIN` | `passt` | binary override (the tests point it at a fake) |

## 5. The wire protocol (for third-party gateways)

Anything that speaks this contract works as a gateway:

- The WebSocket (binary) carries **QEMU's stream-netdev framing as a byte
  stream**: each Ethernet frame is prefixed with a **u32 big-endian length**.
  Message boundaries carry **no meaning** — a frame may span messages, a
  message may hold several frames. (The browser happens to send one frame per
  message; don't rely on it.) Text frames are ignored.
- Length prefixes outside `[14, 2048]` are a protocol error; the browser
  drops the connection and reconnects. Frames over **1522** bytes cannot be
  delivered to the guest — clamp the MTU to 1500.
- Auth: `?token=…` in the request URL.
- Close codes the app renders: `4001` unauthorized · `4002` server full ·
  `4003` backend failed to start · `1011` backend died · `1001` gateway
  shutting down.

This framing is exactly what passt serves on its unix socket and what QEMU's
`-netdev stream` speaks, which buys two alternative gateways for free:

| Gateway | Command | Trade-off |
| --- | --- | --- |
| **This repo's image** | `docker run --rm --security-opt seccomp=unconfined -p 8737:8737 ghcr.io/kartben/zephyr-in-the-browser/gateway` | token auth, per-connection passt, tunnel bundled — the recommended path |
| [c2w-net](https://github.com/container2wasm/container2wasm) (gvisor-tap-vsock) | `c2w-net --listen-ws localhost:8737` | single static Go binary, runs natively on macOS/Windows, no Docker — but no token auth and one shared network stack |
| websocat + one passt | `passt -f -s /tmp/p.sock -4 --mtu 1500 & websocat --binary ws-l:0.0.0.0:8737 unix:/tmp/p.sock` | zero code; single client, no auth — a lab curiosity |
| TAP bridge | a privileged container + `qemu-bridge-helper`-style plumbing | true L2 presence on your LAN; only if you know why you want that |

## 6. Flag recipes

| Goal | How |
| --- | --- |
| Reach the guest's `echo_server` (:4242) | `docker run … -p 4242:4242 -e PASST_ARGS="-a 192.0.2.1 -n 24 -g 192.0.2.2 -t 4242" …` then `nc localhost 4242` |
| Browse the guest's `http_server` (:80) | `docker run … -p 8080:80 -e PASST_ARGS="-a 192.0.2.1 -n 24 -g 192.0.2.2 -t 80" …` then `http://localhost:8080/` — from the LAN, use the gateway machine's address |
| Static guest addressing instead of DHCP | `PASST_ARGS="-a 192.0.2.1 -n 24 -g 192.0.2.2"` (the sandbox's addresses — the server samples above configure 192.0.2.1 themselves, which is why their recipes carry it) |
| Keep IPv6 NDP/DHCPv6 on | `PASST_DEFAULT_ARGS="--mtu 1500"` (the shipped guest images are IPv4-only, so the default is `-4`) |
| Different DNS | `PASST_ARGS="--dns-forward <addr>"` |

## 7. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Safari: `ws://localhost` never connects | Safari treats even loopback `ws://` as mixed content from https pages. Use the `TUNNEL=quick` `wss://` URL. |
| `gateway rejected the token (4001)` in the panel | URL pasted without (or with a stale) `?token=…` — copy the full printed URL. |
| Gateway exits at startup citing seccomp / `4003` on every connect | The `--security-opt seccomp=unconfined` flag is missing (the startup probe prints exactly this). Podman users: rootless podman may allow passt's sandbox without it — try plain first. |
| Connects, DHCP never binds | Check the gateway log for `[passt#n]` lines — passt says why (bad extra flags in `PASST_ARGS` are the usual cause). |
| Large downloads stall, small requests fine | The MTU guard is missing — you overrode `PASST_DEFAULT_ARGS` without `--mtu 1500`. |
| DNS broken under a compose user-defined network | The container's resolver is a loopback stub passt can't hand to the guest — set `PASST_ARGS="--dns-forward <real resolver>"`. |
| Corporate proxy kills the tunnel | Quick tunnels ride HTTPS and usually pass; raw `ws://` to a remote host won't. Prefer `TUNNEL=quick`. |
| Stale lease after gateway restart | Usually nothing to do: a fresh passt mirrors the same subnet, so the old lease keeps routing. To force a new exchange, `net dhcpv4 client start 1` in the guest shell, or restart the emulator (⟳). |
| `4003` for every client after the first, log says `Address in use` | `PASST_ARGS="-t …"` port forwards bind once per gateway, so forwards imply a single client — set `MAX_CLIENTS=1` to make that explicit. (A page reload can trip this transiently; the app's reconnect heals it in under a second.) |

## 8. Limitations

- The shipped guest images are **IPv4-only** (`CONFIG_NET_IPV6=n` in
  [conf/net.conf](../zephyr-module/conf/net.conf)); passt is ready for v6
  when the images are.
- One NIC per board; the netdev is a singleton.
- Throughput is bounded by the ring polling cadence (10 ms hot both sides —
  see [performance.md](performance.md)), not by passt. Plenty for shells,
  HTTP and zperf demos; not a line-rate bridge.
- The proxy outside Docker requires Linux (passt is Linux-only); the
  container runs anywhere Docker does.
