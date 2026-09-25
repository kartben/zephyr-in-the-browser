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
-device virtio-browser-device,bus=virtio-mmio-bus.4,name=i2c,device-id=34,queues=1,features=0x1
-device virtio-browser-device,bus=virtio-mmio-bus.5,name=spi,device-id=45,queues=1,config=04010000800000000f00000080f0fa0200000000000000000000000000000000
```

The payoff is the iteration loop. A new device type, or a new simulated I2C
or SPI chip, is a TypeScript file with a vitest suite — not a containerised QEMU
rebuild.

What it does *not* buy: the guest still needs a driver per device type. GPIO,
I2C and SPI are stock Zephyr now (`drivers/gpio/gpio_virtio.c`,
`drivers/i2c/i2c_virtio.c`, `drivers/spi/spi_virtio.c`); they were vendored
here while they were in review, and anything the bridge grows next may have to
be again ([VENDOR.md](../zephyr-module/drivers/vendor/VENDOR.md)).

The I2C driver requires `VIRTIO_I2C_F_ZERO_LENGTH_REQUEST` (feature bit 0),
which is why the `name=i2c` line above carries `features=0x1`: with it, the out
header's `M_RD` flag is what says whether a message is a read, which is what
[`src/virtio/devices/i2c.ts`](../src/virtio/devices/i2c.ts) decodes.

### When *not* to use the bridge: virtio-blk

The bridge exists because `hw/virtio/` had nothing usable for the devices this
project wanted. For block storage it does: `virtio-blk-device` is stock, and it
was already linked into the packaged emulators — `configs/devices/*/browser.mak`
never disables `CONFIG_VIRTIO_BLK`, which is `default y depends on VIRTIO`. So
the `virtio_blk` sample uses plain QEMU, with a raw image the page allocates in
the Emscripten filesystem:

```
-drive file=/pack/virtio-blk.img,if=none,id=vblk,format=raw,cache=unsafe,file.locking=off
-device virtio-blk-device,drive=vblk,bus=virtio-mmio-bus.6
```

(`cache=unsafe` keeps guest flushes from becoming fsync round trips on MEMFS;
`file.locking=off` skips the `fcntl(F_OFD_SETLK)` probe Emscripten does not
implement.)

Reaching for the bridge here would have been the wrong call — a virtio-blk
device model in TypeScript, reimplementing a protocol QEMU already implements
correctly. What it *would* buy is the two things the stock path gives up:

- **Persistence.** The image lives in MEMFS, so a page reload starts from a
  blank disk. A page-side model could keep sectors in IndexedDB the way
  `src/virtio/devices/flash/model.ts` keeps the SPI NOR in localStorage.
- **Observability.** Sector traffic would show up in the bus log, instead of
  the page only being able to poll the resulting bytes
  ([`src/hostDisk.ts`](../src/hostDisk.ts)).

Both are worth having, neither is worth a from-scratch device model today. If
someone does build it, `device-id=2` is `VIRTIO_ID_BLOCK` and stock QEMU already
names it, so — like GPIO and I2C, and unlike SPI — it needs no `VIRTIO_ID_*`
backport patch.

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
device id (two I2C buses) and index order is a command-line accident. All five
exports are required, and every packaged target that carries the bridge has
them: in `EMULATOR_RELEASE=v101` both aarch64 and riscv32 export all five. The `arm` and `xtensa` artifacts have no bridge at all, which is
right, because `attachVirtio` runs only for a board with `peripherals.virtio`
set (`src/backends/qemu.ts`): the A53 and the RV32 `virt`.

The QEMU-side *diagnostics* (`qemu_virtio_wake_*`, `qemu_virtio_notify_via_*`)
are a different matter, and a per-target one rather than a question of artifact
vintage. `tools/qemu-jit-patches/` 0015 to 0017 add them to aarch64;
`tools/qemu-esp-patches/`, which riscv32 and xtensa build from, has no
counterpart patches. Wake latency and notify source can therefore be read on
the A53 board only, and always could be.

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

Both directions are event-driven. The timers that remain are recovery paths,
never detection paths. The page still cannot touch a virtqueue off the QEMU
thread, so its wake schedules a QEMU bottom half rather than draining inline.

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
  when nothing is in flight. The page also **coalesces kicks across one poll**:
  a multi-message I²C transfer that lands as N request records is answered
  with one `Atomics.notify` + kick rather than N. Delayed replies outside the
  poll (GPIO event queues) still kick immediately.
- **QEMU → page.** After publishing a complete request record and `req_wr`,
  QEMU increments one process-wide futex and calls
  `emscripten_futex_wake()`. A dedicated page worker blocks on that word with
  `Atomics.wait()` and forwards each wake to the main-thread dispatcher. Every
  device model still runs on the main thread, because several of them use
  browser-owned state (`localStorage`, motion events, and UI subscriptions);
  only request detection had to leave it to remove the polling floor globally.
  GPIO is the first model expected to move off the main thread, so that split
  will need restating, but nothing has moved yet.

  The waiter takes its initial expected value before worker creation. A request
  arriving during startup therefore changes the word and makes the worker's
  first wait return immediately, avoiding the usual check-then-sleep race.
  One global word also means one worker covers every virtio-browser instance.

  The waiter is the only request-detection path. There is no hot loop, no
  `MessagePort` nesting reset, and no 50-to-1 ms adaptive window: a waiter that
  cannot start is a loud error, not a silent fallback. `IDLE_MS = 50` survives
  purely as a maintenance tick, covering discovery, reset detection, the
  watchdog, and retrying a completion ring that was momentarily full. It never
  discovers an ordinary request.

  `stats()` in `src/virtio/transport.ts` counts waiter wakeups, surfaced by the
  profiler as `bridgeWakeHz`. `bridgeWakeHz` tracking `bridgeHz` is the check
  that wake coverage is complete.

Under load a blocking transfer used to cost two polling intervals, measured at
~50 I²C Hz on the stock DAC sawtooth. The page now **wakes QEMU on every
completion**: `Atomics.notify` on
`qemu_virtio_browser_wake_addr()` plus `_qemu_virtio_browser_kick()`, which
schedules a BH to drain the cmp rings on the QEMU main loop (BQL held, since
the keepalive export may run on the browser thread) and `qemu_notify_event()`s
a halted vCPU. Of those two, only the kick does any work: nothing in QEMU ever
waits on `virtio_browser_wake`, so the `Atomics.notify` is decorative, and what
actually delivers a completion is `qemu_bh_schedule(virtio_browser_kick_bh)`
inside `qemu_virtio_browser_kick()`. The realtime drain timer is the safety net
for a missed wake, and a real one rather than a formality:
`virtio_browser_arm_drain` rearms it at 1 ms whenever a token is outstanding
and 50 ms otherwise. The reverse direction has the symmetric
`request_wake_addr` futex described above. A local rebuilt A53 artifact measured
~748 atomic request wakes/s, exactly matching requests, with no hot polls; the
DAC period was ~5.5 s. Both QEMU changes are deployed:
`EMULATOR_RELEASE=v97` carries them.

## What a backgrounded tab costs

Worth stating plainly, because it is new: when the device model lived in C, a
GPIO read was answered inside QEMU and never touched the page's event loop. Now
the guest blocks until the page answers, so the page's scheduling is the
guest's scheduling.

With the atomic waiter, request detection is not timer-throttled when the tab
is hidden. QEMU wakes the worker directly and its `postMessage` schedules the
main-thread dispatcher. The browser may still deprioritize the main thread
itself, so this is not a real-time guarantee. The penalty it removes was
deterministic, though: a hidden tab clamps timers to 1 s, so under the old timer
poll the first request after backgrounding waited that long.

Nothing is ever lost: no timeout, no dropped chain, and the watchdog below does
not fire, because the request is answered as soon as the page runs. A guest
driver polling a sensor on a Zephyr timer sees time jump rather than samples go
missing.

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
