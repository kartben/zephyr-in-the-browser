# Plan: add a `qemu_riscv32` emulator

Add a third browser-bootable machine beside Cortex-M3 and Cortex-A53, using
Zephyr’s stock `qemu_riscv32` board (QEMU RISC-V `virt`) as the guest target.
Closest template is **A53** (`virt` + virtio-mmio), not M3.

## Status (implementation landed)

Wiring for the board is in-tree:

| Piece | Location |
| --- | --- |
| Softmmu patches (TCI) | `tools/qemu-riscv-patches/` |
| Build target | `tools/build-qemu-wasm.sh riscv32-softmmu` (`all` still = arm+aarch64) |
| Board registry | `src/boards.ts` → `qemu_riscv32` |
| Shield overlay | `zephyr-module/boards/shields/browser_bridge/boards/qemu_riscv32.overlay` |
| Snippets | `qemu_riscv32/qemu_riscv32` keys (reuse A53 overlay files) |
| Samples | `tools/samples.manifest` (A53 set minus tracing) |
| CI toolchain | `riscv64-zephyr-elf` in `.github/workflows/build-images.yml` |

Still outstanding until a release build is cut: produce `qemu-system-riscv32.wasm`,
package guest ELFs, smoke-test ramfb/LVGL under TCI, optional `-icount` / tracing.

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
| Softmmu | New `riscv32-softmmu` artifact | Separate binary from ARM/AArch64 |
| Accel | Upstream QEMU v10.1.0 + TCI | JIT not validated for RISC-V |
| Guest board | `qemu_riscv32` | Stock Zephyr; `virt`, `-bios none`, `-m 256` |
| Bridges | `tools/qemu-riscv-patches/` on `hw/riscv/virt.c` | Virtio TS is arch-neutral; machine C is not |
| icount | Deferred | Optional Simulation panel later |

## Machine MMIO map (patched)

| Address | Device |
| --- | --- |
| `0x10009000` | `qemu-host-audio` |
| `0x1000a000` | `qemu-host-mic` |
| `0x1000b000` | GNSS 16550 (PLIC IRQ 12) |
| `0x10001000+n×0x1000` | virtio-mmio slots (stock) |
| `0x10100000` | fw_cfg (stock, ramfb) |

Virtio slot policy matches A53: net=0, gpu=1, gpio=2, tablet=3, i2c=4.

## Build

```console
tools/build-qemu-wasm.sh riscv32-softmmu
tools/build-zephyr-image.sh qemu_riscv32
```

## Sample matrix

Same as A53 except **tracing** (ARM semihosting). Display/LVGL expected to work
but run slower on TCI than A53 JIT.

## Risks still to validate in a real wasm build

1. ramfb + fw_cfg ordering on pinned QEMU v10.1.0 for RISC-V virt
2. TCI performance for LVGL / accel_chart
3. Artifact size before folding riscv32 into `all` / release tarballs
4. GNSS second UART IRQ wiring through Zephyr’s ns16550 + PLIC
