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
-device virtio-browser-device,bus=virtio-mmio-bus.5,name=spi,device-id=45,queues=1,config=04010000800000000f00000080f0fa0200000000000000000000000000000000
```

The payoff is the iteration loop. A new device type, or a new simulated I2C
or SPI chip, is a TypeScript file with a vitest suite — not a containerised QEMU
rebuild.

What it does *not* buy: the guest still needs a driver per device type. For
virtio-gpio and virtio-spi that driver is vendored
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
TypeScript. Payloads are usually tens of bytes; SPI already carries bulk
transfers (NOR page program, WS2812 strip frames of a few hundred bytes). When
a device wants more still, the escape hatch is to expose the iovec host
pointers, not to change this protocol.

## Discovery

Device instances register themselves into a global array at realize. The page
finds them by name:

| Export | Meaning |
| --- | --- |
| `_qemu_virtio_browser_count()` | number of instances |
| `_qemu_virtio_browser_area(i)` | pointer to instance *i*'s `VirtioBrowserArea` |
| `_qemu_virtio_browser_wake_addr()` | futex word the page `Atomics.notify`s after `cmp_wr` |
| `_qemu_virtio_browser_request_wake_addr()` | futex word QEMU increments and notifies after `req_wr` |
| `_qemu_virtio_browser_kick()` | drain every cmp ring now + `qemu_notify_event()` |

`name` is matched rather than `device_id`, because two instances can share a
device id (two I2C buses) and index order is a command-line accident. The wake
exports are optional for older wasm builds. Without the completion exports,
QEMU's realtime drain timer remains the safety net; without the request export,
the page retains its adaptive timer poll.

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

Both directions are event-driven in a current emulator, with the old timers
retained as compatibility and recovery paths. The page still cannot touch a
virtqueue off the QEMU thread, so its wake schedules a QEMU bottom half rather
than draining inline.

- **Page → QEMU.** A virtual-clock timer would be wrong here. This is the first
  bridge where the guest *blocks* on a browser answer, so the browser's
  asynchronous response must not advance a guest-clock polling loop. The drain
  therefore runs on `QEMU_CLOCK_REALTIME`:
  **1 ms while tokens are parked**, **50 ms idle** (safety net + `config_gen`).

  Completions are kicked into a BH; the idle timer is only recovery and
  config-change notification. Without kick, a synchronous guest
  (`dac_write` → `k_sem_take(K_FOREVER)` → answer → `k_sleep`) used to wait out
  idle between transfers — **10 ms idle → ~45 I²C Hz** on Cortex-A53 `dac`.
  Kick removed that ceiling; raising idle to 50 ms (matching the page's
  maintenance tick) avoids waking the QEMU main loop once per ms per device
  when nothing is in flight.
- **QEMU → page.** After publishing a complete request record and `req_wr`,
  QEMU increments one process-wide futex and calls
  `emscripten_futex_wake()`. A dedicated page worker blocks on that word with
  `Atomics.wait()` and forwards each wake to the main-thread dispatcher. The
  device models remain on the main thread because several use browser-owned
  state (`localStorage`, motion events, and UI subscriptions); only request
  detection has to leave it to remove the polling floor globally.

  The waiter takes its initial expected value before worker creation. A request
  arriving during startup therefore changes the word and makes the worker's
  first wait return immediately, avoiding the usual check-then-sleep race.
  One global word also means one worker covers every virtio-browser instance.

  Older emulator artifacts, non-shared test modules, and a waiter that reports
  an error use the previous adaptive timer: a paced 1 ms hot loop for 100 ms,
  then a 50 ms idle poll. Its `MessagePort` nesting reset is retained because
  nested timers otherwise settle at ~4 ms in a visible tab, while an unpaced
  message loop was measured at ~700k shared-memory loads/s. The waiter path
  keeps only a 50 ms maintenance tick for discovery, resets, watchdogs, and
  completion-ring backpressure; ordinary request arrival never waits for it.

  `stats()` in `src/virtio/transport.ts` exposes `waiterActive` and
  `waiterWakeups`, surfaced by the profiler as `bridgeWaiterActive` and
  `bridgeWakeHz`. `bridge_waiter_inactive` flags a hot I²C window that is still
  on the compatibility poll.

Under load a blocking transfer used to cost two polling intervals — measured
at ~50 I²C Hz on the stock DAC sawtooth. The page now **wakes QEMU on every
completion**: `Atomics.notify` on
`qemu_virtio_browser_wake_addr()` plus `_qemu_virtio_browser_kick()`, which
schedules a BH to drain the cmp rings on the QEMU main loop (BQL held — the
keepalive export may run on the browser thread) and `qemu_notify_event()`s a
halted vCPU. The realtime drain timer stays as a safety net for old emulators
and missed wakes. The reverse direction now has the symmetric
`request_wake_addr` futex described above. A local rebuilt A53 artifact measured
~748 atomic request wakes/s, exactly matching requests, with no hot polls; the
DAC period was ~5.5 s. Both QEMU changes require publishing that rebuilt wasm
artifact before the deployed page can use them.

## What a backgrounded tab costs

Worth stating plainly, because it is new: when the device model lived in C, a
GPIO read was answered inside QEMU and never touched the page's event loop. Now
the guest blocks until the page answers, so the page's scheduling is the
guest's scheduling.

With the atomic waiter, request detection is not timer-throttled when the tab
is hidden. QEMU wakes the worker directly and its `postMessage` schedules the
main-thread dispatcher. The browser may still deprioritize the main thread
itself, so this is not a real-time guarantee, but it removes the deterministic
one-second first-request penalty of the compatibility timer.

Nothing is ever lost: no timeout, no dropped chain, and the watchdog below does
not fire, because the request is answered as soon as the page runs. A guest
driver polling a sensor on a Zephyr timer sees time jump rather than samples go
missing.

Older emulator artifacts still use the timer path and can show the original
symptom: `req_wr` pinned with one chain outstanding until the tab runs again.

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
