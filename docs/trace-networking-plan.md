# Trace · Networking tab — plan

Unlike FIFO/LIFO, **Zephyr CTF already emits networking events**. Upstream
[`tracing_ctf.h`](https://github.com/zephyrproject-rtos/zephyr/blob/main/subsys/tracing/ctf/tracing_ctf.h)
wires `sys_port_trace_socket_*` and `sys_port_trace_net_*` to real emitters;
the TSDL in `public/tracing/metadata` already declares them (`0x36`–`0x61`).
We are not waiting on an upstream CTF gap — we are missing a Trace tab that
reconstructs and renders them.

**Status: Phases 0 and 1 shipped; Phases 2 and 3 are not built.** The Networking
tab is in the Trace panel — socket swimlanes, the metrics header and the
net-core latency strip. The connection ribbon and the cross-panel niceties were
never started. The design below stands as written; the sentences that described
the app as it was before the tab existed are re-tensed rather than deleted, and
[Status](#status) at the end says exactly what landed.

## Goals

1. Add a third Trace tab — **Networking** — that makes socket lifecycle and
   stack I/O readable the way Schedule shows threads and Message Queues show
   `k_msgq`.
2. Share the Trace panel’s time window (zoom / pan / live-follow) so a zperf
   run can be correlated across Schedule ↔ Networking ↔ (optionally) Queues.
3. Stay **guest-CTF-first**: decode what Zephyr already writes to
   `./tracing.bin`. Do not duplicate the Network panel’s frame capture.

## Non-goals (this feature)

- Replacing [`NetworkPanel`](../src/components/NetworkPanel.tsx) / `src/net/`
  (LAN sandbox, pcap, latency injection). That stays the **wire** view; this
  tab is the **guest stack / BSD sockets** view.
- Packet payloads or L7 decode from CTF (events carry lengths and addresses,
  not bodies).
- Upstream CTF changes (unless we later want richer fields).
- RISC-V / boards without `hostTrace` — same constraint as Message Queues.

## Why this is viable now

| Layer | Status |
| --- | --- |
| CTF hooks (`socket_*`, `net_*`) | Implemented in Zephyr CTF backend |
| TSDL metadata | Present in `public/tracing/metadata` |
| Kconfig | Pin `CONFIG_TRACING_NETWORKING` / `NET_SOCKETS` / `NET_CORE` in `tracing.conf`; traced net samples also pull `browser-tracing-net` / `tracing-net.conf` (keeps `NET_IPV6=n` — decoder probes 20-byte address strings vs TSDL `[46]`) |
| Demo sample | A53 `zperf_trace` ships with `browser-tracing` + auto-expanded Trace |
| App decoder | Was loading full metadata but **mishandling `address[46]`** — fixed, see below |
| App UI | Was `schedule \| queues`; now `schedule \| queues \| net` (`TracePanel.tsx`) |

Contrast with FIFO/LIFO: those hooks are **no-ops** under CTF. Networking was
the opposite — the events existed and the page ignored them, which is the whole
reason this was cheap.

## Event inventory (canonical)

Source of truth: Zephyr TSDL + `ctf_top.h` ids `0x36`–`0x61`.

### Socket API (`CONFIG_TRACING_NET_SOCKETS`)

Lifecycle / naming:

| Event | Role for UI |
| --- | --- |
| `socket_init` | Birth: fd → `{family, type, proto}` |
| `socket_close_*` | Death |
| `socket_bind_enter` | Local `address` + `port` |
| `socket_connect_enter` / `*_exit` | Peer intent + result |
| `socket_listen_*` | Server mode + backlog |
| `socket_accept_exit` | New fd + peer `address`/`port` (result ≥ 0) |
| `socket_shutdown_*` | Half-close |

Data path (primary traffic signal):

| Event | Fields that matter |
| --- | --- |
| `socket_sendto_enter` | `id`, `data_length`, dest `address` |
| `socket_sendto_exit` | `result` (bytes or `-errno`) |
| `socket_recvfrom_enter` / `*_exit` | max / actual length, src `address` |
| `socket_sendmsg_*` / `socket_recvmsg_*` | Same story via msghdr length |

Secondary (defer or collapse into detail drawer):

- `fcntl` / `ioctl` / `getsockopt` / `setsockopt`
- `getpeername` / `getsockname`
- `poll_*` (+ `socket_poll_value` fan-out)
- `socketpair_*`

### Net core (`CONFIG_TRACING_NET_CORE`)

| Event | Role for UI |
| --- | --- |
| `net_recv_data_enter` / `*_exit` | iface + `pkt` + `pkt_len` + result |
| `net_send_data_enter` / `*_exit` | same on TX |
| `net_rx_time` / `net_tx_time` | `duration_us`, priority, traffic class |

These are **packet-pointer** traces, not socket-fd traces. Useful for a
stack-latency strip and iface throughput; do not force them onto the socket
swimlanes.

## Prerequisite (shipped): decoder must honour `address[46]`

Socket address fields are `ctf_bounded_string_t address[46]` in TSDL, matching
`ctf_net_bounded_string_t` (`NET_INET6_ADDRSTRLEN` when IPv6 is on — and zperf
enables IPv6).

`parseMetadata` in `src/ctf/metadata.ts` used to collapse **every**
`ctf_bounded_string_t` to `str20`, with a comment that “[20] covers it.” That
was false for networking events: bodies are **26 bytes longer** per address
field than we assumed, so the first socket event in a stream desynced the
decoder from that point forward (Schedule/Queues also suffered if net events
appeared earlier in the file).

Landed before the tab, as the three pieces this section asked for:

1. `FieldKind` is `string | { str: number }`, so `makeEventDef` takes a
   variable-width string.
2. `parseMetadata` reads the `N` out of `ctf_bounded_string_t name[N]`, and
   defaults to 20 when the width is omitted.
3. Regression fixtures in `src/ctf/metadata.test.ts` decode a synthetic
   `socket_bind_enter` followed by `thread_switched_in`, plus the negative case
   — what the old 20-byte assumption would have scrambled.

What the spec did not foresee is that honouring the TSDL is not enough on its
own. The browser LAN is IPv4-only, and `ctf_top.h` only emits 46-byte address
strings when `CONFIG_NET_IPV6=y`, so a real guest writes 20 where the metadata
promises 46 — trusting the declaration is as fatal as ignoring it. The fix is
the runtime probe the Risks table below anticipated: `src/ctf/netAddressWidth.ts`
peeks the next record's event id to decide which width the guest actually used,
and only fields declared `[46]` are ambiguous (a thread `name[20]` is not a
candidate).

## Relationship to the Network panel

```
┌─ Network panel ─────────────┐     ┌─ Trace · Networking ──────────┐
│ Host sandbox frames         │     │ Guest CTF socket / net_*      │
│ pcap · DHCP · latency knobs │     │ fd lifecycle · bind/connect   │
│ “what hit the virtual wire” │     │ “what the Zephyr stack did”   │
└─────────────────────────────┘     └───────────────────────────────┘
         ▲                                      ▲
         └──────── same wall-clock story ───────┘
                   (no shared cursor v1)
```

Optional later: click a CTF send ↔ highlight nearby Network-panel frames by
timestamp. Not required for v1.

## Proposed UX

Third Trace tab label: **Networking** (short; matches Schedule / Message Queues).
The two it sits beside had already been shortened by the time it landed, so the
shipped row reads **Timeline · Queues · Networking**; the sketches below still
use the older labels.

### One composition (default)

Shared Trace chrome (tabs + zoom/pan/live). Body:

```
┌─ Trace ── [Schedule] [Message Queues] [Networking] ─── ± live ─┐
│  sockets 3 · tx 1.2 MB · rx 980 KB · err 2     (visible window) │
│                                                                 │
│  fd 3  UDP4  * :5001          ████░▓▓▓░░░▓▓████  → 192.0.2.2    │
│  fd 4  TCP4  192.0.2.1:49152  ░░▓▓▓▓▓▓▓░░░░░░░  ↔ peer         │
│  fd 5  TCP6  [::]:4242        ░░░░░░████░░░░░░  listen          │
│  ──────── iface 1 · net_* ────────────────────────────────────  │
│  rx latency (µs)              ··▁▂▃▂▁·▁▃▅▃▁·                   │
│  tx / rx B/s                  ────────╱╲────                    │
└─────────────────────────────────────────────────────────────────┘
```

**Rules**

- **Socket swimlanes** are the hero — one lane per live (or recently closed)
  fd, labelled `fd N · family/type · local`.
- Traffic inside a lane: send = one hue, recv = another; failed exits = hatch
  or dim mark. No card chrome; same canvas language as Schedule/Queues.
- **Connection ribbon** (optional strip above lanes or SVG overlay): edges
  from socket → peer address for connect/accept/sendto destinations, heat by
  recent byte volume — the “fancy” cousin of `QueueGraph`, but endpoint-
  addressed, not msgq mouths. *Not built (Phase 2).*
- **Net-core strip** under the lanes: compact `net_rx_time` / `net_tx_time`
  latency sparkline + byte rate from `net_*_data_enter` lengths. Collapse
  when no `net_*` events exist. *Built, minus the byte rate — the strip draws
  the two µs lines only.*
- Empty state: “No socket CTF events in this window” + hint that the sample
  needs `CONFIG_TRACING_NET_SOCKETS` (zperf A53 already qualifies).
- Keep fcntl/poll/setopt out of the first viewport — detail on lane select.

### Selection / info strip

*Not built (Phase 2).* `NetView` has no hit-testing of its own — the only
pointer gestures on the canvas are the pan and box-zoom the Trace panel hands
every tab. The per-socket totals it would have shown are drawn in the lane
gutter instead.

Selecting a lane shows: family/type/proto, bind/connect endpoints, totals
(tx/rx bytes, error count), last op + result, actor thread (via
`threadRunningAt`, same as queues).

### What “super fancy” means here

*Not built (Phase 2)* — the canvas repaints, it does not animate. Kept because
it is still the bar to clear if anyone picks this up.

Intentional motion and hierarchy, not dashboard clutter:

1. Lane appears with a short fade when `socket_init` enters the window.
2. Byte marks bloom then settle (same hot→warm idea as QueueGraph edges).
3. Live-follow gently pins the right edge; new traffic ticks the metrics
   strip without layout thrash.

Avoid: stat card grids, protocol icon rows, floating badges on the chart.

## Reconstruction model

New module sketch: `src/ctf/netSockets.ts` (+ tests), exported from
`src/ctf/index.ts`. That is where it landed, close enough to the sketch that
the types below still read as documentation; the shipped `SocketSeries` also
carries `firstTs` / `lastTs` so a lane knows how wide to draw.

```ts
type SockKey = number // fd from event field `id` (or accept result)

interface SocketIdentity {
  fd: SockKey
  family: number
  type: number
  proto: number
  local?: { address: string; port?: number }
  peer?: { address: string; port?: number }
  state: 'open' | 'listening' | 'connected' | 'closed'
}

interface SocketSample {
  ts: number
  op: 'send' | 'recv' | 'bind' | 'connect' | 'accept' | 'listen' | 'close' | …
  bytes?: number      // from enter length or successful exit result
  ok: boolean
  address?: string
  threadId: number | null
}

interface SocketSeries {
  socket: SocketIdentity
  samples: SocketSample[]
  txBytes: number
  rxBytes: number
  errors: number
}
```

**Algorithm (v1)**

1. Scan events in order; ignore non-socket / non-net names (or id ranges).
2. `socket_init` → open series keyed by fd.
3. Bind/connect/listen/accept update identity; `accept_exit` with `result ≥ 0`
   opens a **child** series for the new fd.
4. Send/recv: on *enter* record intended length + address; on *exit* commit
   sample with `ok = result ≥ 0` and `bytes = ok ? result : 0` (sendto/recvfrom
   convention). Pair enter→exit loosely by fd + monotonic scan (nested calls
   on one fd are rare; document if we see reordering).
5. `socket_close_exit` marks closed (keep series for the visible window).
6. Parallel pass: `net_*` → `NetCoreSeries` by `if_index` for the bottom strip.

Family/type/proto: map well-known constants to labels (`UDP4`, `TCP6`, …)
with a small table; unknown → raw numbers.

## UI wiring

| Piece | Change | Status |
| --- | --- | --- |
| `TracePanel.tsx` | `TraceTab = 'schedule' \| 'queues' \| 'net'`; third tab button | shipped |
| `NetView.tsx` (new) | Canvas swimlanes + metrics; takes `view0/view1`, `tr`, `eventCount` | shipped |
| `NetGraph.tsx` (optional v1.1) | SVG connection ribbon; can land after lanes | not built |
| `hostTrace` / boards | No change if zperf already traces; verify events present in a capture | no change needed; net CTF comes from the `browser-tracing-net` snippet |
| Mock backend | Script a short socket CTF blob for CI without QEMU | the vitest suite hand-encodes CTF records; there is no mock backend |

Default tab: remain Schedule. zperf may later prefer Networking when Trace
auto-expands — optional, not load-bearing.

## Implementation phases

### Phase 0 — Decoder correctness (blocker) — shipped

- Variable-width bounded strings in metadata parse + decode.
- Tests with `[46]` address fields.
- Confirm zperf `tracing.bin` still yields a coherent Schedule after the fix
  (net events were already scrambling long captures).
- Not in the original list, and the part that actually bit: the 20-vs-46
  runtime probe, because the guest disagrees with its own TSDL.

### Phase 1 — Swimlanes + metrics — shipped

- `reconstructSockets` / `reconstructNetCore`.
- `NetView` canvas aligned to Trace time window.
- Tab chrome + empty state.
- Vitest on reconstruction (init→bind→sendto→recvfrom→close).

### Phase 2 — Connection ribbon + polish — not built

- Peer graph / heat edges.
- Lane select detail strip.
- Motion (appear / bloom) respecting reduced-motion if the app has a signal.

### Phase 3 — Cross-panel niceties (optional) — not built

- Deep-link timestamps toward Network panel.
- Poll event summary in Schedule info strip (“net busy”).
- Named-event hooks if samples emit `named_event` around zperf phases.

## Risks

| Risk | Mitigation |
| --- | --- |
| `address[46]` desync | Phase 0 first; never ship UI without it |
| High event rate from zperf floods CTF / UI | Aggregate marks into time buckets when zoomed out; same trick as dense Schedule |
| fd reuse after close | Key series by `(fd, generation)` — bump generation on `socket_init` for a previously closed fd |
| IPv4-only builds use 20-byte net strings | Decoder **probes** 20 vs 46 on the first `address[46]` event (peek next eid). Tracing snippets keep `NET_IPV6=n`; never re-enable IPv6 for layout matching |
| Confusing two “network” UIs | Copy: Trace tab = “guest sockets”; Network panel keeps “page LAN” |

Two of those mitigations are in the code: the width probe, and `(fd, generation)`
keying so a reused fd starts a new series. The bucketing is not — a dense window
still draws one mark per sample.

## Demo path

1. Phase 0 + 1 against a checked-in synthetic CTF fixture.
2. Boot A53 **zperf** (Trace already primary).
3. Run `zperf udp upload 192.0.2.2 …` from the shell; Networking tab should
   show the UDP socket lane and TX marks; Network panel still shows frames.
4. Screenshot / short capture for the PR.

## Mockup

Visual target (static HTML, no build):

[`docs/mockups/trace-networking.html`](mockups/trace-networking.html)

## Status

**Phase 0 + Phase 1 landed**, in the files this plan named:

- `src/ctf/metadata.ts` — parse honours `ctf_bounded_string_t …[N]`
  (socket `address[46]`), tested in `metadata.test.ts`.
- `src/ctf/netAddressWidth.ts` — the 20-vs-46 probe for guests built without
  IPv6, which is every guest here.
- `src/ctf/netSockets.ts` — `reconstructSockets` / `reconstructNetCore` /
  `socketWindowStats`, with vitest coverage of the fd lifecycle, `accept`
  child series and fd reuse.
- `src/components/NetView.tsx` — swimlanes, the `sockets / tx / rx / err`
  header, the `net_rx / net_tx µs` strip (drawn only when `net_*` events
  exist), and the empty state naming `CONFIG_TRACING_NET_SOCKETS`.
- `src/components/TracePanel.tsx` — `TraceTab` and the third tab button.
  Schedule stays the default tab, as specified.

**Still open**, and unstarted rather than half-done: the connection ribbon and
the lane-select detail strip (Phase 2), the motion, and the cross-panel
timestamp linking (Phase 3). There is no `NetGraph.tsx`.

