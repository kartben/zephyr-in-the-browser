# GDB in the browser: feasibility study

The question: can this tab expose a real debugger against the running Zephyr
guest — stop/continue, breakpoints, registers, memory — the way native
`west debug` does against QEMU?

**Verdict: yes, and cheaper than it sounds — QEMU's gdbstub is already in the
binary; the only missing piece is a transport the browser can speak.** A full
`gdb` (or LLDB) compiled to Wasm is not worth shipping. What *is* buildable is
the same shape every other bridge here uses: expose the stub over a browser
chardev, then pick a client.

## What already exists for free

QEMU's softmmu always carries a **gdbstub** that speaks the GDB Remote Serial
Protocol (RSP). It is not gated behind `--enable-gdbstub`; `--without-default-features`
does not strip it. Native Zephyr already uses it:

```console
qemu-system-arm -s -S -kernel zephyr.elf   # -s ≡ -gdb tcp::1234
arm-zephyr-eabi-gdb zephyr.elf
(gdb) target remote :1234
```

Under TCG (both the Cortex-M3 TCI and the A53 wasm JIT) the stub advertises an
unlimited supply of hardware breakpoints and watchpoints, so `break` /
`watch` work without patching guest RAM. Multicore is irrelevant here: both
boards are uniprocessor.

So the guest side needs **nothing** — no Zephyr Kconfig, no vendor driver, no
snippet. The question collapses to "how does an RSP client in (or near) the
tab reach the stub?"

## Blocker: `-s` is a TCP listen, and the tab has no TCP

`-gdb tcp::1234` (and `-s`) asks QEMU to `listen()` on a socket. In this build
there is no POSIX socket stack that can accept connections from outside the
Wasm module — the same reason networking is an in-page LAN rather than a real
NIC (see [networking.md](networking.md)). Emscripten's websocket-to-posix
proxy would restore it, but only by requiring a host daemon next to the page,
which the GitHub Pages demo cannot assume.

Unix sockets (`-chardev socket,path=…`) are the same dead end in a browser.

That is the **only** hard blocker, and it is the same one every other
stream-shaped bridge here already solved.

## What is buildable: a browser chardev for the stub

QEMU does not hard-wire the stub to TCP. `-gdb` takes any chardev:

```
-chardev <something>,id=gdb0 -gdb chardev:gdb0 [-S]
```

`<something>` can be a new `browser-gdb` backend that copies the GNSS UART
pattern ([next-drivers.md](next-drivers.md) shape 3 — bidirectional char
device):

- Page ↔ QEMU over a pair of lock-free rings in the Wasm heap
  (`SharedArrayBuffer`), drained on the QEMU thread by a
  `QEMU_CLOCK_REALTIME` timer — the same discipline the virtio bridge uses
  when the guest waits on a browser answer.
- Two exported entry points for JavaScript (`qemu_browser_gdb_write` /
  ring-index readers), mirroring `qemu_browser_gnss_feed_byte`.
- Optional `-S` so the guest stays halted until a client attaches — useful for
  "break before `main`" demos, optional otherwise so a panel that is not open
  does not stall the boot.

Cost: one QEMU C file of roughly GNSS size, a thin `src/hostGdb.ts` bridge,
argv wired from `src/boards.ts`, and an emulator rebuild. Works on **both**
boards — the stub is machine-agnostic, unlike virtio.

No Zephyr change. No guest driver. The packaged ELFs keep booting exactly as
they do today when nobody attaches.

## The client is the real product decision

Three clients sit on top of that one transport. They are not mutually
exclusive; the cheap ones unlock the expensive one later.

### 1. Host GDB over a WebSocket proxy — cheapest proof (dev only)

A tiny local proxy (websockify, or the Emscripten posix-sockets proxy) turns
the in-tab rings into a TCP port on `localhost`. Then:

```console
arm-zephyr-eabi-gdb zephyr.elf
(gdb) target remote :1234
```

Exactly the `west debug` workflow, pointed at a browser tab instead of a
native QEMU. Proves the transport end-to-end with zero UI work. Useless on
GitHub Pages (needs a daemon and a local toolchain), fine as a `npm run dev`
opt-in.

### 2. In-page minimal debugger — the demo that fits this repo

A floating panel that speaks enough RSP to be useful without pretending to be
GDB:

| Capability | RSP packets | Notes |
| --- | --- | --- |
| Halt / continue / step | `?`, `c`, `s`, stop-reply | Core loop |
| Registers | `g` / `G` / `p` / `P` | Arch-specific layouts for Armv7-M and AArch64 |
| Memory | `m` / `M` | Hex dump already has a UI (`HexView`) |
| Breakpoints | `Z0` / `z0` (software) or `Z1`/`z1` (hardware) | TCG gives hardware "for free" |
| Watchpoints | `Z2`/`Z3`/`Z4` | Same |

This is a few hundred lines of TypeScript against a well-specified byte
protocol, not a GDB port. It reuses the panel chrome and the hex viewer. It
is also the only client that preserves the project's pitch — *no install,
runs in a tab*.

What it will **not** do in v1: source-level stepping with locals and stack
unwinding. That needs DWARF, and the packaged images deliberately do not
carry it (see below).

### 3. GDB or LLDB compiled to Wasm — do not bother

`gdb` multiarch is tens of megabytes; LLDB-to-Wasm experiments exist
(~50–60 MB) and still want a socket-shaped transport plus their own UI
chrome. Shipping a second Wasm runtime the size of the emulator itself, to
duplicate a stub QEMU already owns, fails every size and maintenance test
this repo applies to new artifacts. Revisit only if an upstream
`gdb-wasm` / `lldb-wasm` becomes a small, RSP-client-shaped library — not a
full IDE backend.

## The symbols problem (orthogonal, and already decided)

`zephyr-module/conf/stripped.conf` sets `CONFIG_BUILD_OUTPUT_STRIPPED=y`, and
`tools/build-zephyr-image.sh` ships `zephyr.strip`. The comment is explicit:
the linked ELF is ~1.5 MB of DWARF against ~64 KB of loadable image, fetched
over HTTP on every boot. That choice is correct for the demo.

Consequences for a debugger:

- **Without symbols** the in-page panel is still valuable: PC/SP/LR, a
  register grid, a memory hex view, address breakpoints. Enough to answer
  "why is this guest wedged?" — which is the question this emulator's own
  development keeps asking.
- **Source-level** needs the unstripped ELF (or a split `.debug` companion)
  *and* the matching sources. Options, in rising cost:
  1. A parallel `*.dbg.elf` artifact in the release tarball, fetched only
     when the debugger panel opens — keeps the default boot small.
  2. Accept a user-dropped unstripped ELF (the drop-an-ELF path already
     exists) and debug *that*, which is the case that matters for someone
     bringing their own firmware.
  3. Host GDB (option 1 above) pointed at a local `zephyr.elf` with full
     DWARF and a source tree — zero browser-side DWARF work.

DWARF-in-the-browser parsers exist, but they are their own project. Nothing
in the transport work depends on them; ship registers-and-breakpoints first,
add symbols when a concrete user needs `list` / `bt`.

## Interaction with the rest of the emulator

- **`-icount` (A53).** The stub stops the VM; icount simply stops advancing.
  No conflict. Single-step under `shift=4` will feel slow in wall time — that
  is the interpreter/JIT tax, not a gdbstub bug.
- **Cortex-M3 TCI.** Same story, worse constant factors. Functional, not
  pleasant for tight step-loops; prefer the A53 for interactive sessions.
- **ASYNCIFY / PROXY_TO_PTHREAD.** The stub runs on QEMU's own thread and
  talks through a ChardevFrontend, like the monitor. A ring drained by a
  realtime timer stays on the right side of the BQL — copy the virtio-bridge
  completion path, not a virtual-clock one (the guest is *stopped*, so a
  virtual clock would never fire).
- **Document taint / no clean restart.** Attaching a debugger does not change
  the existing "reload to reboot" rule in `src/backends/qemu.ts`.

## Ranking against other work

Compared to the peripherals in [next-drivers.md](next-drivers.md):

| | QEMU C patch | Guest driver | Demo value |
| --- | --- | --- | --- |
| Browser-gdb chardev + host-GDB proxy | ~GNSS-sized | none | high for *developers of this repo* |
| + in-page panel (regs/mem/break) | same patch | none | high for the public demo |
| + DWARF / source view | none extra | none | nice-to-have; big JS dependency |

It is closer to "expose something QEMU already does" (ramfb pixels,
guest icount) than to "invent a device." That puts it ahead of any net-new
peripheral on raw effort, and behind GPIO/display/net on visitor-facing demo
sparkle — unless the visitor is trying to understand why their guest hung.

## Recommended path

1. **Patch in a `browser-gdb` chardev** and start both boards with
   `-chardev browser-gdb,id=gdb0 -gdb chardev:gdb0` (no `-S` by default).
2. **Prove it** with a one-file WebSocket↔ring proxy and host
   `arm-zephyr-eabi-gdb` / `gdb-multiarch` against an unstripped local build.
3. **Panel v1**: halt/continue/step, register grid, memory hex, breakpoint
   list — no DWARF.
4. **Symbols later**, as a lazily-fetched `*.dbg.elf` or via the existing
   custom-ELF drop, only if someone actually asks for `list`.

Skip compiling GDB itself to Wasm. Skip anything that needs a daemon for the
Pages deploy. The transport is the whole novelty; everything past that is a
client choice.
