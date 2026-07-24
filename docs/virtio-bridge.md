# The generic virtio bridge

The contract between `hw/virtio/virtio-browser.c` in the patched QEMU and
[`src/virtio/`](../src/virtio) in the page. Both sides are written against this
document; if you change one, change this and the other.

## Why it exists

Every device this project has added so far cost a QEMU C patch — that is the
real price of a peripheral here, not the JS panel (see
[next-drivers.md](next-drivers.md)). virtio-gpio made it worse rather than
better: the guest gained a *stock* driver, but the device model moved into 576
lines of C, because `hw/virtio/` ships only `vhost-user-gpio.c`, a shim onto a
daemon a single-process wasm build cannot run.

The bridge inverts that. QEMU keeps only the parts that must happen on the QEMU
thread under the BQL — popping descriptor chains, gathering and scattering
their iovecs, pushing to the used ring, raising the interrupt — and everything
that makes a device *that* device lives in TypeScript. The virtio device id,
queue count, feature bits and config space are command-line properties, so one
C file is a GPIO controller, an I2C adapter, or anything else:

```
-device virtio-browser-device,bus=virtio-mmio-bus.2,name=gpio,device-id=41,queues=2,features=0x1,config=0800000000000000
-device virtio-browser-device,bus=virtio-mmio-bus.4,name=i2c,device-id=34,queues=1
```

The payoff is the iteration loop. A new device type, or a new simulated I2C
chip, is a TypeScript file with a vitest suite — not a containerised QEMU
rebuild.

What it does *not* buy: the guest still needs a driver per device type. For
virtio-gpio that driver is vendored
([VENDOR.md](../zephyr-module/drivers/vendor/VENDOR.md)); for I2C it does not
exist in Zephyr yet and has to be written.

## Shape

```
guest  <--virtqueue-->  QEMU (BQL, QEMU thread)  <--SPSC rings-->  page JS
```

Requests flow out of the virtqueues into a request ring; the page answers into
a completion ring; QEMU matches answers to parked chains by token and completes
them. Payloads are bounce-buffered through the rings rather than mapped, which
costs a copy and buys not having to walk guest scatter-gather lists in
TypeScript. Payloads here are tens of bytes; when a device wants more, the
escape hatch is to expose the iovec host pointers, not to change this protocol.

## Discovery

Device instances register themselves into a global array at realize. The page
finds them by name:

| Export | Meaning |
| --- | --- |
| `_qemu_virtio_browser_count()` | number of instances |
| `_qemu_virtio_browser_area(i)` | pointer to instance *i*'s `VirtioBrowserArea` |

`name` is matched rather than `device_id`, because two instances can share a
device id (two I2C buses) and index order is a command-line accident.

## The shared area

One per instance, at a fixed address for the life of the process. All fields
are little-endian `uint32_t` unless noted. `TOTAL_MEMORY=2GB` with no
`ALLOW_MEMORY_GROWTH` means the heap never moves, so the pointer stays valid
and typed-array views over it never need rebuilding.

| Field | Written by | Meaning |
| --- | --- | --- |
| `magic` | QEMU | `0x47524256` (`"VBRG"`), sanity check |
| `version` | QEMU | protocol version, currently 1 |
| `device_id` | QEMU | virtio device id (41 gpio, 34 i2c) |
| `num_queues` | QEMU | virtqueues the device exposes |
| `name[16]` | QEMU | NUL-padded, matched by the page |
| `req_off`, `req_size` | QEMU | request ring, offset from the area base |
| `cmp_off`, `cmp_size` | QEMU | completion ring, likewise |
| `req_wr` | QEMU | free-running request write index |
| `req_rd` | **page** | free-running request read index |
| `cmp_wr` | **page** | free-running completion write index |
| `cmp_rd` | QEMU | free-running completion read index |
| `outstanding` | QEMU | parked tokens, for the page's backpressure view |
| `reset_gen` | QEMU | bumped on device reset; the page drops in-flight state |
| `config_len` | QEMU | bytes of `config` the device advertises |
| `config_gen` | **page** | bumped to request a config-change interrupt |
| `config[64]` | both | device config space, seeded by QEMU, writable by the page |

Indices are free-running `uint32_t` and wrap naturally; `(wr - rd) >>> 0` is the
occupancy. A record never straddles the end of a ring — a `token` of
`0xffffffff` is a skip marker sending the reader to the next lap, the same
convention [`src/net/ringCodec.ts`](../src/net/ringCodec.ts) uses.

### Records

Request, QEMU to the page:

```
u32 token | u16 queue | u16 flags | u32 out_len | u32 in_cap | u8 out[out_len] pad4
```

Completion, the page to QEMU:

```
u32 token | u16 flags | u16 reserved | u32 in_len | u8 in[in_len] pad4
```

`out` is the concatenated device-readable part of the chain, `in_cap` the
capacity of its device-writable part. A completion whose `in_len` exceeds
`in_cap` is truncated and logged as a guest-visible error.

`token` is `slot | (generation << 16)`: the slot indexes QEMU's parked-element
table, the generation makes a stale completion — one arriving after a reset —
detectable rather than a use-after-free.

## Parking

Nothing requires the page to answer a request, and answering out of order is
fine. A queue whose chains the page holds indefinitely is exactly virtio-gpio's
event queue: the driver arms one chain per line and the device completes it
when the line's interrupt condition is met. No special case in the protocol —
"parked" just means a token the page has not answered yet.

The parked-element table is 64 entries. When it fills, or the request ring has
no room, QEMU stops popping that virtqueue rather than dropping chains: a
dropped request hangs a guest driver forever on `k_sem_take(..., K_FOREVER)`.
The drain timer retries stalled queues.

## Timing

Both directions poll. Neither side can cheaply wake the other:
`MAIN_THREAD_ASYNC_EM_ASM` is unused anywhere in qemu-wasm, and the page cannot
touch a virtqueue off the QEMU thread.

- **Page → QEMU.** A virtual-clock timer would be wrong here. This is the first
  bridge where the guest *blocks* on a browser answer, and under
  `-icount shift=4,sleep=on` the virtual clock warps forward to the next
  deadline whenever the vCPUs idle — so a virtual-clock drain would race ahead
  of the browser, fire on an empty ring, warp again, and inflate guest time
  while making no progress. The drain therefore runs on `QEMU_CLOCK_REALTIME`:
  1 ms while tokens are parked, 10 ms idle.
- **QEMU → page.** `setTimeout(…, 0)` for 250 ms after any request, falling
  back to a 50 ms timer when idle. Deliberately *not* a `MessageChannel` loop:
  that would give a true zero-delay macrotask, but this is the main thread, and
  spinning one for the duration of a transfer burst starves rendering. Nested
  `setTimeout(0)` is clamped to ~4 ms by browsers, and that is a fine price.

Budget is therefore roughly 5 ms per blocking transfer — the page's ~4 ms plus
QEMU's 1 ms — and one shared-memory read per device per 50 ms at rest. A GPIO
poke is imperceptible; a 127-address `i2c scan` lands near 0.6 s. If measurement ever demands better,
the levers in order are: proxying a wake onto the page via
`MAIN_THREAD_ASYNC_EM_ASM`, `qemu_bh_schedule()` from the page to wake the main
loop on completion, and a shadow register file the QEMU thread can answer
cached reads from without leaving the thread at all.

## A backgrounded tab stalls the guest

Worth stating plainly, because it is new. When the device model lived in C, a
GPIO read was answered inside QEMU and never touched the page's event loop. Now
the guest blocks until the page answers, and a hidden or backgrounded tab has
its timers throttled to roughly once a minute — so guest GPIO stops until the
tab is foregrounded again, then resumes exactly where it left off. Observed
directly: `blinky` freezes mid-toggle with `req_wr` pinned and one chain
outstanding, and continues the moment the tab is visible.

Nothing is lost — no timeout, no dropped chain, and the watchdog below does not
fire because the request is answered as soon as the page runs again. But it
means any device on this bridge is only live while the tab is. That is fine for
a foreground demo, and it is the same bargain the rest of the page already
makes; it is worth remembering for an I2C sensor whose driver polls on a
Zephyr timer, which will see time jump rather than samples go missing.

## Watchdog

A device model in TypeScript can hang the guest by never answering. The page
fails a token that has gone unanswered for 5 s, and logs it. Deliberately
generous: parking is legal and indefinite, so the watchdog only covers tokens a
device *claimed* and then dropped, not ones it is holding on purpose.

## Reset

On device reset QEMU detaches every parked chain, empties both rings, and bumps
`reset_gen`. The page notices the change on its next poll and discards its
in-flight token map. Nothing is migrated: parked chains cannot be, and the page
is the far end of the wires anyway.
