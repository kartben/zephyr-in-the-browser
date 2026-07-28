# Trace · Networking tab — plan

Unlike FIFO/LIFO, **Zephyr CTF already emits networking events**. Upstream
[`tracing_ctf.h`](https://github.com/zephyrproject-rtos/zephyr/blob/main/subsys/tracing/ctf/tracing_ctf.h)
wires `sys_port_trace_socket_*` and `sys_port_trace_net_*` to real emitters;
the TSDL in `public/tracing/metadata` already declares them (`0x36`–`0x61`).
We are not waiting on an upstream CTF gap — we are missing a Trace tab that
reconstructs and renders them.

This document is the **spec only**. No product UI yet.

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
| App decoder | Loads full metadata, but **mishandles `address[46]`** (see below) |
| App UI | Tabs are `schedule \| queues` only today |

Contrast with FIFO/LIFO: those hooks are **no-ops** under CTF. Networking is
the opposite — events exist; the page ignores them.

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

## Prerequisite: decoder must honour `address[46]`

Socket address fields are `ctf_bounded_string_t address[46]` in TSDL, matching
`ctf_net_bounded_string_t` (`NET_INET6_ADDRSTRLEN` when IPv6 is on — and zperf
enables IPv6).

Today `parseMetadata` in `src/ctf/metadata.ts` collapses **every**
`ctf_bounded_string_t` to `str20`, with a comment that “[20] covers it.” That
is false for networking events: bodies are **26 bytes longer** per address
field than we assume, so the first socket event in a stream desyncs the
decoder from that point forward (Schedule/Queues also suffer if net events
appear earlier in the file).

**Must ship before or with** the Networking tab:

1. Teach `FieldType` / `makeEventDef` a variable-width string (`strN` or
   `{ str: n }`), already partially present as `FieldKind`.
2. In `parseMetadata`, when `ctf_bounded_string_t name[N]` appears, use `N`
   (default 20 if omitted).
3. Add regression fixtures: synthetic `socket_bind_enter` + following
   `thread_switched_in` must both decode.

Until this lands, do not enable Networking UI against live zperf traces.

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
  addressed, not msgq mouths.
- **Net-core strip** under the lanes: compact `net_rx_time` / `net_tx_time`
  latency sparkline + byte rate from `net_*_data_enter` lengths. Collapse
  when no `net_*` events exist.
- Empty state: “No socket CTF events in this window” + hint that the sample
  needs `CONFIG_TRACING_NET_SOCKETS` (zperf A53 already qualifies).
- Keep fcntl/poll/setopt out of the first viewport — detail on lane select.

### Selection / info strip

Selecting a lane shows: family/type/proto, bind/connect endpoints, totals
(tx/rx bytes, error count), last op + result, actor thread (via
`threadRunningAt`, same as queues).

### What “super fancy” means here

Intentional motion and hierarchy, not dashboard clutter:

1. Lane appears with a short fade when `socket_init` enters the window.
2. Byte marks bloom then settle (same hot→warm idea as QueueGraph edges).
3. Live-follow gently pins the right edge; new traffic ticks the metrics
   strip without layout thrash.

Avoid: stat card grids, protocol icon rows, floating badges on the chart.

## Reconstruction model

New module sketch: `src/ctf/netSockets.ts` (+ tests), exported from
`src/ctf/index.ts`.

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

| Piece | Change |
| --- | --- |
| `TracePanel.tsx` | `TraceTab = 'schedule' \| 'queues' \| 'net'`; third tab button |
| `NetView.tsx` (new) | Canvas swimlanes + metrics; takes `view0/view1`, `tr`, `eventCount` |
| `NetGraph.tsx` (optional v1.1) | SVG connection ribbon; can land after lanes |
| `hostTrace` / boards | No change if zperf already traces; verify events present in a capture |
| Mock backend | Script a short socket CTF blob for CI without QEMU |

Default tab: remain Schedule. zperf may later prefer Networking when Trace
auto-expands — optional, not load-bearing.

## Implementation phases

### Phase 0 — Decoder correctness (blocker)

- Variable-width bounded strings in metadata parse + decode.
- Tests with `[46]` address fields.
- Confirm zperf `tracing.bin` still yields a coherent Schedule after the fix
  (today net events may already scramble long captures).

### Phase 1 — Swimlanes + metrics

- `reconstructSockets` / `reconstructNetCore`.
- `NetView` canvas aligned to Trace time window.
- Tab chrome + empty state.
- Vitest on reconstruction (init→bind→sendto→recvfrom→close).

### Phase 2 — Connection ribbon + polish

- Peer graph / heat edges.
- Lane select detail strip.
- Motion (appear / bloom) respecting reduced-motion if the app has a signal.

### Phase 3 — Cross-panel niceties (optional)

- Deep-link timestamps toward Network panel.
- Poll event summary in Schedule info strip (“net busy”).
- Named-event hooks if samples emit `named_event` around zperf phases.

## Risks

| Risk | Mitigation |
| --- | --- |
| `address[46]` desync | Phase 0 first; never ship UI without it |
| High event rate from zperf floods CTF / UI | Aggregate marks into time buckets when zoomed out; same trick as dense Schedule |
| fd reuse after close | Key series by `(fd, generation)` — bump generation on `socket_init` for a previously closed fd |
| IPv4-only builds use 20-byte net strings | Decoder **probes** 20 vs 46 on the first `address[46]` event (peek next eid). `tracing-net.conf` still re-enables `NET_IPV6` for zperf so guest layout matches TSDL after image rebuild |
| Confusing two “network” UIs | Copy: Trace tab = “guest sockets”; Network panel keeps “page LAN” |

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

**Phase 0 + Phase 1 landed** on `cursor/trace-networking-spec-0424`:

- Metadata parse honours `ctf_bounded_string_t …[N]` (socket `address[46]`).
- `reconstructSockets` / `reconstructNetCore` + vitest coverage.
- Trace tab **Networking** with swimlanes, metrics strip, and net-core latency
  sparkline (`NetView`).

Still open from the original phases: connection ribbon (Phase 2), cross-panel
timestamp linking (Phase 3).

