# Plan: add a `qemu_x86` emulator

Add a fourth browser-bootable machine beside Cortex-M3, Cortex-A53, and
RISC-V 32, using Zephyr’s stock `qemu_x86` board (QEMU **q35** / `qemu-system-i386`)
as the guest target.

## Status (first cut in-tree)

| Piece | Location |
| --- | --- |
| Softmmu patches (TCI) | `tools/qemu-x86-patches/` |
| Build target | `tools/build-qemu-wasm.sh i386-softmmu` (`all` still = arm+aarch64) |
| Board registry | `src/boards.ts` → `qemu_x86` |
| Shield overlay | `zephyr-module/boards/shields/browser_bridge/boards/qemu_x86.overlay` |
| Snippets | `qemu_x86/atom` keys for host-gpio samples (`gpio-buzzer`, `gpio-step-dir`) |
| Samples | `tools/samples.manifest` — M3-like + display/touch/net (no virtio-mmio I²C/SPI) |
| CI toolchain | `x86-zephyr-elf` in `.github/workflows/build-images.yml` |

Still outstanding until a release build is cut: produce `qemu-system-i386.wasm`,
package guest ELFs, smoke-test ramfb / virtio-tablet-pci / e1000 under TCI.

## Goal

Ship `qemu-system-i386` wasm artifacts and enough Zephyr/page wiring that the
**stock q35 surface** works in the browser: UART console, GNSS on COM2, host
GPIO/audio/mic, ramfb display, virtio-tablet touch, and e1000 networking through
the browser netdev.

## Non-goals (first cut)

- PCI wrappers for `virtio-browser-device` (GPIO/I²C/SPI as virtio-pci) — the
  TypeScript bridge today assumes virtio-mmio buses; see
  [virtio-bridge.md](virtio-bridge.md) and `VENDOR.md`
- `qemu_x86_64` / lakemont / tiny variants
- Upstream TCI performance parity with A53 JIT
- Folding `i386-softmmu` into `all` / default release tarballs

## Why this shape

| Concern | Choice | Rationale |
| --- | --- | --- |
| Softmmu | New `i386-softmmu` artifact | Separate binary; QEMU name is `qemu-system-i386` |
| Accel | Upstream QEMU v10.1.0 + TCI | Same as M3 / riscv32; no x86 JIT path here |
| Guest board | `qemu_x86` → `qemu_x86/atom` | Stock Zephyr; `-machine q35,acpi=off`, `-cpu qemu32,+nx,+pae`, `-m 32` |
| Bridges | `tools/qemu-x86-patches/` on `hw/i386/pc.c` | Virtio TS is arch-neutral; machine C is not |
| Net | `e1000` + `browser` netdev | Stock Zephyr DTS (`intel,e1000`), not virtio-net-mmio |
| Touch | `virtio-tablet-pci` | Stock board DTS / board.cmake |
| Sensors / SPI NOR | Deferred | Need virtio-pci + new overlays |

## Machine map (patched)

| Address / port | Device |
| --- | --- |
| COM1 `0x3f8` | Console NS16550 (stock) |
| COM2 `0x2f8` | GNSS NS16550 → browser GNSS chardev |
| `0xfea00000` | `qemu-host-gpio` |
| `0xfea01000` | `qemu-host-audio` |
| `0xfea02000` | `qemu-host-mic` |
| `0x510` | fw_cfg I/O (stock, ramfb) |

## Build

```console
tools/build-qemu-wasm.sh i386-softmmu
tools/build-zephyr-image.sh qemu_x86
```

## Sample matrix

Closer to **M3** (host-gpio / shell / gnss / net) plus A53’s **display** and
**touch** (ramfb + virtio-tablet-pci). Omits virtio-i2c/spi sensor and flash
samples until a PCI virtio-browser path exists.

## Risks still to validate in a real wasm build

1. q35 + TCI artifact size vs arm/aarch64
2. ramfb via fw-cfg I/O ports under emscripten
3. e1000 + browser netdev link/IRQ behaviour on q35 without ACPI
4. Host MMIO at `0xfea0_0000` mapped through Zephyr’s x86 MMU (`DEVICE_MMIO_MAP`)
5. COM2 GNSS IRQ (IRQ 3) vs Zephyr `uart1` interrupt-driven GNSS
