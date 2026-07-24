# Networking: the page is the LAN

The guest has a real Ethernet interface (stock QEMU NICs: `stellaris_enet` on
Cortex-M3, virtio-net on Cortex-A53), but its cable ends in this browser tab:
a patched-in `browser` netdev hands every frame to page JavaScript, and
**the page plays the entire network** ([src/net/](../src/net)) — gateway
`192.0.2.2`, DHCP, DNS, and every "remote host" at once. It is a sandbox, not
a NAT: **no packet ever reaches the real internet.** Exactly two things
escape the tab, both as ordinary browser requests:

| The guest does…                        | What actually happens                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| DHCP                                   | The page leases it `192.0.2.1` (same address the static samples use)                                                                              |
| DNS lookup                             | **Real** answer, fetched via DNS-over-HTTPS — offline it invents a `203.0.113.x` |
| HTTP to any host on `:80`/`:8080`      | Re-issued as a **real** `fetch()` over https. Readable only if the site allows CORS; `http://host.internal/` always works                          |
| `net ping <any address>`               | The **page** replies, pretending to be that host — a reachability prop, not a probe. Nothing was pinged                                            |
| HTTPS, raw TCP/UDP to the internet     | Impossible — browser pages have no raw sockets                                                                                                    |
| Runs a server (`http_server`, `echo_server`) | Reachable only from the Network panel's GET/echo tools — the page dials in over its own TCP                                                  |
| SNTP                                   | Answered with your browser's clock                                                                                                                |
| `zperf udp upload 192.0.2.2 5001 …`    | Measured by an in-page iperf2-compatible sink                                                                                                     |

Because every frame crosses the page, the Network panel shows live RX/TX
charts, a tiny tcpdump with one-click **.pcap download** (opens in Wireshark),
link up/down, and latency/loss injection. The stack is dependency-free
TypeScript with a vitest suite (`npm test`); under the mock backend a scripted
fake guest drives the same stack, so the panel demos without a QEMU build.
The same summary lives behind the ⓘ button in the panel itself.

Fuller networking is on the radar: an **opt-in uplink** that would tunnel the
guest's frames over a WebSocket to a local [passt](https://passt.top/)
(or gvisor-tap-vsock) gateway, giving real DHCP/DNS/TCP/UDP — even real ping —
when you run a small daemon next to the dev server. The in-page sandbox would
remain the default: it needs no helper and nothing to trust.
