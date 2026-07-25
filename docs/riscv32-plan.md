# Plan: add a `qemu_riscv32` emulator

Add a third browser-bootable machine beside Cortex-M3 and Cortex-A53, using
Zephyr’s stock `qemu_riscv32` board (QEMU RISC-V `virt`) as the guest target.
Closest template is **A53** (`virt` + virtio-mmio), not M3.

## Goal

Ship `qemu-system-riscv32` wasm artifacts and enough Zephyr/page wiring that
**most A53 samples** run on riscv32 with the same panels (virtio GPIO/I2C/net,
GNSS, audio, display where feasible).

## Non-goals (first cut)

- RISC-V JIT / ktock wasm backend (AArch64-only today) — start on **upstream TCI**
- `qemu_riscv64` / SMP / AIA variants
- New TypeScript virtio device models (reuse A53’s)
- Host-GPIO MMIO (prefer virtio-gpio like A53)
- Perfect wall-clock timing or MIPS parity with A53 JIT

## Why this shape

| Concern | Choice | Rationale |
| --- | --- | --- |
| Softmmu | New `riscv32-softmmu` artifact | Separate binary from ARM/AArch64; same pattern as today’s two targets |
| Accel | Upstream QEMU v10.1.0 + TCI | JIT fork is not validated for RISC-V; TCI matches M3’s build path |
| Guest board | `qemu_riscv32` | Upstream Zephyr board; `virt`, `-bios none`, `-m 256`, virtio-mmio in DT |
| Bridges | Port A53 JIT patches onto RISC-V `virt` | Virtio TS + guest drivers are arch-neutral; machine C is not |
| icount | Optional, later | Useful for the Simulation panel; not required to boot samples. See below |

`-icount` mainly retimes the guest clock; with `align=off,sleep=on` it does not
typically crush host throughput. Defer it until hello/net/virtio work, then add
if the MIPS panel is wanted on this board.

## Architecture map

```
Browser UI (src/)
  boards.ts ──► qemu-system-riscv32.{js,wasm}
                    │
                    ├─ stock: virtio-net, virtio-tablet, (ramfb / virtio-gpu)
                    ├─ patched: virtio-browser, GNSS UART, host-audio/mic,
                    │            browser netdev, (optional guest-icount)
                    └─ Zephyr ELF: qemu_riscv32 + browser_bridge shield
                         │
                         └─ snippets: virtio-gpio / virtio-i2c / … (new board keys)
```

Reuse without rewrite: `src/virtio/**`, net stack, dock panels, most of
`src/backends/qemu.ts` (already probes every unique `qemuBinary`).

## Phases

### Phase 0 — Spike: softmmu + hello_world

Prove the third artifact boots one guest. No virtio yet.

**Emulator**

1. Extend `tools/build-qemu-wasm.sh`:
   - Accept `riscv32-softmmu` (and include it in `all`, or keep `all` = arm+aarch64 and document an explicit target until stable).
   - Route through the **TCI** tree + `tools/qemu-patches/` (or a new `tools/qemu-riscv-patches/` series — prefer a dedicated series so ARM Stellaris patches are not applied to a RISC-V-only tree by accident).
2. Add `configs/devices/riscv32-softmmu/browser.mak` that keeps QEMU’s RISC-V `virt` (and whatever fw_cfg / ramfb / virtio deps need). Follow the trim style of the existing browser.mak patches.
3. Minimum patches for a serial hello:
   - Emscripten xterm-pty link (already in both series)
   - Link `-O3` (optional, match others)
   - Device catalogue trim for riscv32

**Page / guest**

4. `Board` entry in `src/boards.ts`:
   - `zephyrTarget: 'qemu_riscv32'`
   - `qemuBinary: 'qemu-system-riscv32'`
   - argv aligned with Zephyr’s `boards/qemu/riscv32/board.cmake`  
     (`-machine virt`, `-bios none`, `-m 256`, `-cpu` matching the board ISA, `-nographic`, `-kernel …`)
5. Empty or minimal `browser_bridge` board overlay  
   `zephyr-module/boards/shields/browser_bridge/boards/qemu_riscv32.overlay`
6. Manifest + sample list: `hello_world` only
7. CI: add Zephyr SDK toolchain that covers rv32 (today
   `toolchains: arm-zephyr-eabi:aarch64-zephyr-elf` in
   `.github/workflows/build-images.yml`). Expect **`riscv64-zephyr-elf`**
   (SDK multililib for rv32/rv64) — confirm against the SDK version CI pins.
8. `tools/package-emulator.sh`: include `qemu_riscv32` when packaging images.

**Exit criteria:** `tools/build-qemu-wasm.sh riscv32-softmmu` produces artifacts;
`hello_world.elf` prints over the browser terminal.

### Phase 1 — Virtio-net + net samples

Virtio-mmio exists on RISC-V `virt` at `0x10001000 + n×0x1000` (Zephyr
`virt-riscv.dtsi`: `virtio_mmio0`…`7`). Slot numbering must match Zephyr’s
board / our shield the same way A53 uses `virtio-mmio-bus.N`.

1. Land **browser netdev** + **generic virtio-browser** into the riscv32 softmmu
   (C is mostly target-agnostic; meson/`browser.mak` must compile them in).
2. Mirror A53 argv for net:
   - `-global virtio-mmio.force-legacy=false`
   - `-netdev browser,id=n0`
   - `-device virtio-net-device,netdev=n0,bus=virtio-mmio-bus.0,mac=02:00:00:00:00:01`
3. Shield overlay: enable the matching virtio-mmio node / Ethernet chosen if
   Zephyr’s riscv32 board does not already (A53 relies on stock board + shield).
4. Package `dhcp`, `http_get`, `http_server`, `echo_server` (and later `zperf`).

**Exit criteria:** DHCP lease from the in-page LAN; HTTP GET through the proxy.

### Phase 2 — Virtio-gpio / virtio-i2c

1. Argv: `virtio-browser-device` on the same relative slots as A53 where
   possible (net=0, gpu=1, gpio=2, tablet=3, i2c=4) **or** document a riscv32
   slot map if Zephyr’s board.cmake already reserves different indices —
   **match native `west build -t run` when Zephyr defines it**.
2. Extend every relevant snippet’s `boards:` keys (today hard-coded to
   `qemu_cortex_a53/...`):
   - `virtio-gpio`, `virtio-i2c`, `*-only` sensor/RTC/EEPROM/OLED/auxdisplay,
     `i2c-sensors-extra`, `accel-display`
3. Either share overlays (if MMIO node names match) or add
   `boards/qemu_riscv32.overlay` siblings under each snippet.
4. Package: `blinky`, `basic_button`, one sensor (`lsm6dso` or `isl29035`),
   `eeprom`, then the rest of the I²C set + `shell` / `oled` / `auxdisplay` /
   `rtc`.

**Exit criteria:** Button IRQ via `VIRTIO_GPIO_F_IRQ`; one I²C chip visible in
the dock and talking to a stock Zephyr sample.

### Phase 3 — GNSS + host audio / mic

Machine-specific. A53 patches instantiate devices in `hw/arm/virt.c` at fixed
holes (`0x090c/d/e0000`) and a second **PL011**. RISC-V `virt` uses a **16550**
at `0x10000000` and a different MMIO map.

1. Find unused MMIO holes in `hw/riscv/virt.c` (avoid virtio window, CLINT,
   PLIC/APLIC, UART, test device, DRAM).
2. Port:
   - GNSS char backend → second UART (extra 16550, or another model Zephyr can
     bind; may need a small Zephyr DT node + driver compatible)
   - `qemu,host-audio` / `qemu,host-mic` at the chosen addresses
3. `qemu_riscv32.overlay`: aliases `gnss`, `dmic0`, register blocks matching the
   patch addresses.
4. Package `gnss`; enable audio/mic conf on `shell` like A53.

**Exit criteria:** NMEA fixes in the GNSS panel; `hostaudio` / mic paths on shell.

### Phase 4 — Display, touch, LVGL

Highest risk / payoff after virtio basics.

1. Confirm **ramfb + fw_cfg** on this QEMU version’s RISC-V `virt` (upstream has
   had fw_cfg ordering issues with ramfb; v10.1.0 needs a smoke test:
   `-device ramfb` must not fail at startup).
2. Reuse ramfb browser export patch if the display device is shared; wire
   exports into the riscv32 build.
3. Input bridge + `virtio-tablet-device` on the tablet slot.
4. Shrink framebuffer in the shield overlay (A53 uses 600×400).
5. Package `display`, `touch`, then `lvgl_music` / `accel_chart` if TCI MIPS is
   tolerable (expect slower than A53 JIT; may need smaller LVGL conf).

**Fallback:** I²C OLED path (`oled` sample) needs no ramfb and can ship earlier
in Phase 2.

**Exit criteria:** ramfb paints in the Display panel; touch draws; or explicit
doc that display stays A53-only until ramfb is sorted.

### Phase 5 — Polish

1. Optional `-icount shift=4,align=off,sleep=on` + guest-icount export for the
   Simulation panel (`perfStats: true`).
2. Semihosting CTF / `tracing` sample if the FS follow path works unchanged.
3. philosophers / HSM / remaining A53 apps.
4. Docs: `public/qemu/README.md`, `docs/peripherals.md`, sample matrix;
   update `docs/README.md` link from “plan” to “how it works” when done.
5. CI release scripts / Pages packaging include the third wasm binary (watch
   artifact size).

## File / area checklist

| Area | Touch |
| --- | --- |
| `tools/build-qemu-wasm.sh` | `riscv32-softmmu` target routing |
| `tools/qemu-riscv-patches/` (new) or extend TCI series | Device trim, bridges, machine wiring in `hw/riscv/virt.c` |
| `src/boards.ts` | New `Board`, sample list, argv, `peripherals` |
| `tools/samples.manifest` | `qemu_riscv32:…` lines per phase |
| `zephyr-module/boards/shields/browser_bridge/boards/qemu_riscv32.overlay` | UART/audio/virtio nodes |
| `zephyr-module/snippets/*/snippet.yml` (+ overlays) | `qemu_riscv32/...` board keys |
| `.github/workflows/build-images.yml` | RISC-V toolchain |
| `west.yml` | Only if a module is missing for rv32 builds |
| `tools/package-emulator.sh` | Board loop |
| `public/qemu/README.md`, this doc | Contract + status |

**Do not rewrite:** `src/virtio/devices/*`, chip models, net stack, panel
components — gate them with `board.peripherals` flags as today.

## Sample compatibility (target end state)

| Sample class | Phase | Notes |
| --- | --- | --- |
| `hello_world`, `hsm`, `philosophers` | 0 / 5 | Rebuild only |
| Net samples | 1 | virtio-net + browser netdev |
| `blinky`, `basic_button` | 2 | virtio-gpio snippet |
| Sensors / EEPROM / RTC / OLED / auxdisplay / shell I²C | 2 | virtio-i2c + snippet board keys |
| `gnss`, host audio/mic | 3 | New UART + MMIO holes |
| `display`, `touch`, LVGL, `accel_chart` | 4 | ramfb/fw_cfg risk; TCI speed |
| `tracing` | 5 | semihosting |
| MIPS / Simulation panel | 5 | optional icount |

## Risks and open questions

1. **Second UART for GNSS** — RISC-V `virt` ships one 16550; need an extra
   serial device the Zephyr GNSS sample can open (compatible string + IRQ).
2. **MMIO hole selection** — must not collide with virtio (`0x10001000+`),
   CLINT, PLIC, PCIe windows; document addresses next to the A53 ones in the
   shield overlay comments.
3. **ramfb on riscv32** — verify fw_cfg DMA availability at device creation on
   pinned QEMU; may block Phase 4 without a QEMU bump or small patch.
4. **TCI performance** — LVGL may be painful; mitigate with smaller FB / conf,
   or accept “A53 preferred for graphics.”
5. **Patch series hygiene** — applying ARM Stellaris host-gpio patches to a
   RISC-V build is wasteful/noisy; a dedicated `qemu-riscv-patches/` (TCI-based)
   keeps ARM and RISC-V series independent.
6. **Toolchain / west allowlist** — confirm SDK toolchain id; add HALs only if
   a sample fails module lookup (sensor HALs are already listed for A53).
7. **Artifact size / Pages budget** — third `.wasm` is large; measure before
   making it part of the default `all` build and release tarball.

## Suggested implementation order (PRs)

1. **Spike PR:** softmmu build + board registry + hello_world (Phase 0)
2. **Net PR:** browser netdev in riscv softmmu + net samples (Phase 1)
3. **Virtio PR:** gpio/i2c bridge + snippets + sensor subset (Phase 2)
4. **Bridges PR:** GNSS + audio/mic machine wiring (Phase 3)
5. **Display PR:** ramfb/touch/LVGL or documented deferral (Phase 4)
6. **Polish PR:** icount, tracing, docs, packaging (Phase 5)

Each PR should leave `main` bootable for M3/A53; riscv32 can land behind a
board picker entry that only appears when `qemu-system-riscv32.wasm` is present
(same probe pattern as today).

## Acceptance for “done”

- Board selectable in the UI when the wasm artifact is present
- Virtio GPIO, I2C, and net samples work with the existing panels
- GNSS + at least one of audio/mic or a clear deferral note
- Display either works (ramfb or OLED-only story) or is explicitly out of scope
  in `public/qemu/README.md`
- CI can build `qemu_riscv32` images with the RISC-V toolchain
- M3 and A53 regressions: none
