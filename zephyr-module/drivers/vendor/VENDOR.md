# Vendored upstream sources

Files here are mostly **pristine copies** of code that is not yet in the Zephyr
tree this repo builds against (byte-identical to an upstream revision so drift
is a one-line `diff` away). `auxdisplay_gpio_7seg.c` is the exception: it is a
deliberate fix of an in-tree ISR misuse — see that section. Everything else
under `zephyr-module/` is this repo's own code.

Each pristine entry is retired — deleted, along with its Kconfig and the CMake
guard that builds it — as soon as the upstream commit lands in mainline Zephyr.

## `display_virtio_gpu.c`

VIRTIO GPU 2D display driver.

| | |
| --- | --- |
| Upstream | <https://github.com/kartben/zephyr/tree/codex/virtio-gpu-display> |
| Commit | `1ede0f8c44a6cff69d90e7e5a3dfab6051087ff4` — *drivers: display: add virtio GPU support* |
| Path | `drivers/display/display_virtio_gpu.c` |
| SHA-256 | `77594d8cb48bac9f24d83b02e800d1af03d578fcbf7a48271f9d95b2d9a007f8` |

Shipped alongside it, also unmodified from the same commit:

- `zephyr-module/dts/bindings/display/virtio,gpu.yaml` — the `virtio,gpu`
  binding (`drivers/../dts/bindings/display/virtio,gpu.yaml` upstream),
  SHA-256 `f19a353c479d59ed9b0aa6179a53efb524d85eeca95212e9173a7e8fd75fce7a`.

The upstream commit also carries a `qemu_x86` board enablement and a
`virtio-gpu` snippet for it. Neither is vendored: this repo needs the driver on
`qemu_cortex_a53` (virtio-mmio, not PCI), so it ships its own snippet at
`zephyr-module/snippets/virtio-gpu/` and its own devicetree node in the
`browser_bridge` shield. The driver source itself is architecture-neutral.

### Checking for drift

```console
diff <(gh api repos/kartben/zephyr/contents/drivers/display/display_virtio_gpu.c?ref=codex/virtio-gpu-display --jq .content | base64 -d) \
     zephyr-module/drivers/vendor/display_virtio_gpu.c
```

### Kconfig symbol collision

`CONFIG_VIRTIO_GPU_DISPLAY` and `CONFIG_VIRTIO_GPU_DISPLAY_QUEUE_SIZE` are
declared in `zephyr-module/Kconfig` under the *same names* upstream uses, so
that the migration is a pure deletion rather than a rename. If the upstream
commit merges, Kconfig will simply merge the two identical definitions, but the
driver would be compiled twice and fail to link — which is why
`zephyr-module/CMakeLists.txt` builds the vendored copy only when
`${ZEPHYR_BASE}/drivers/display/display_virtio_gpu.c` does not exist.

## `auxdisplay_shell.c`

Auxiliary display shell module (`auxdisplay` commands: write, clear, cursor, …).

| | |
| --- | --- |
| Upstream | <https://github.com/kartben/zephyr/tree/auxdisplay_shell_> |
| Commit | `2c6a159a57b193cd43696076f6524f779cf73557` — *drivers: auxdisplay: add shell module for testing* |
| Path | `drivers/auxdisplay/auxdisplay_shell.c` |
| SHA-256 | `a5dc27b44a5f1c225e639ae4db4cc7630cf2b44d0d7733aeafca54076b97beb6` |

Upstream also adds `CONFIG_AUXDISPLAY_SHELL` to `drivers/auxdisplay/Kconfig` and
a one-line `zephyr_library_sources_ifdef` in that directory's CMakeLists — the
Kconfig symbol is mirrored here under the same name; CMake builds this copy
only while `${ZEPHYR_BASE}/drivers/auxdisplay/auxdisplay_shell.c` is absent.
The docs tweak in that commit is not vendored.

### Checking for drift

```console
diff <(gh api "repos/kartben/zephyr/contents/drivers/auxdisplay/auxdisplay_shell.c?ref=auxdisplay_shell_" --jq .content | base64 -d) \
     zephyr-module/drivers/vendor/auxdisplay_shell.c
```

### Kconfig symbol collision

`CONFIG_AUXDISPLAY_SHELL` is declared in `zephyr-module/Kconfig` under the
*same* name upstream uses, with the same CMake guard on
`${ZEPHYR_BASE}/drivers/auxdisplay/auxdisplay_shell.c`.

## `auxdisplay_gpio_7seg.c`

GPIO-driven 7-segment auxdisplay — **patched** fork of the in-tree driver.

| | |
| --- | --- |
| Upstream | <https://github.com/zephyrproject-rtos/zephyr/blob/main/drivers/auxdisplay/auxdisplay_gpio_7seg.c> |
| Based on | `a258a4b017e6` — *auxdisplay: gpio-7seg: fix display glitch* |
| Path | `drivers/auxdisplay/auxdisplay_gpio_7seg.c` |

Unlike the pristine vendored drivers above, this file is **intentionally
diverged**: upstream's `k_timer` expiry (and stop) handlers call
`gpio_pin_set_dt()` from interrupt context. That is unsafe for any GPIO
controller that may sleep or take a virtqueue round trip — in particular
`virtio,gpio`, which this repo uses on the browser boards. The ISR flood
deadlocks the qemu-wasm console (blank terminal while I²C/SPI still move).

The fix keeps the same `gpio-7-segment` compatible and auxdisplay API, but
schedules multiplex refresh on a `k_work_delayable` so GPIO updates run on the
system workqueue (thread context).

### Coexistence with in-tree

Both drivers claim `DT_DRV_COMPAT gpio_7_segment`. Enable only one:

- `CONFIG_AUXDISPLAY_GPIO_7SEG=n` (in-tree off)
- `CONFIG_AUXDISPLAY_GPIO_7SEG_WQ=y` (this copy)

`zephyr-module/conf/auxdisplay-shell.conf` sets that pair. CMake always builds
this file when `CONFIG_AUXDISPLAY_GPIO_7SEG_WQ` is set — there is no “wait until
upstream deletes its copy” guard, because the upstream file exists and is the
problem.

### Retire when

Upstream moves refresh (and blank-on-stop) out of ISR context. Then delete this
file, drop `CONFIG_AUXDISPLAY_GPIO_7SEG_WQ`, and re-enable
`CONFIG_AUXDISPLAY_GPIO_7SEG`.

## Retired

Gone from here because mainline Zephyr ships them. The guest side of the
generic browser virtio bridge is now stock Zephyr; the page side stays in
`src/virtio/devices/` (see [docs/virtio-bridge.md](../../../docs/virtio-bridge.md)).

| Was | Now in Zephyr | Landed as |
| --- | --- | --- |
| `gpio_virtio.c`, `virtio,gpio.yaml` | `drivers/gpio/gpio_virtio.c` | `d97541ecf2b`: *drivers: gpio: add VIRTIO GPIO driver* |
| `i2c_virtio.c`, `virtio,i2c.yaml` | `drivers/i2c/i2c_virtio.c` | `38206798076`: *drivers: i2c: add VIRTIO I2C adapter driver* |
| `spi_virtio.c`, `virtio,spi.yaml` | `drivers/spi/spi_virtio.c` | `5e057c6d8ce`: *drivers: spi: add VIRTIO SPI driver* |

Their Kconfig symbols (`CONFIG_GPIO_VIRTIO`, `CONFIG_I2C_VIRTIO`,
`CONFIG_I2C_VIRTIO_MAX_MSGS`, `CONFIG_SPI_VIRTIO`) kept the upstream names all
along, so nothing in `conf/` or the snippets had to change.

One review change did reach the page: the merged I2C driver requires
`VIRTIO_I2C_F_ZERO_LENGTH_REQUEST` (feature bit 0), so the `name=i2c` device in
`src/boards.ts` offers `features=0x1`. Without it the driver refuses to
initialize and the bus never comes up.
