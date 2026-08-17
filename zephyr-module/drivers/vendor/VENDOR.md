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

## `gpio_virtio.c`

VIRTIO GPIO driver (virtio spec 1.3, section 5.18).

| | |
| --- | --- |
| Upstream | <https://github.com/zephyrproject-rtos/zephyr/pull/114983> |
| Commit | `ca318983a157a366fd67debbcfaaa83ef02d4405` — *drivers: gpio: add VIRTIO GPIO driver* |
| Path | `drivers/gpio/gpio_virtio.c` |
| SHA-256 | `052e1510cf2c4fbb840e3fba4e716a9528587c56749fb839c45c5fc1f1e7e5cf` |

Shipped alongside it, also unmodified from the same commit:

- `zephyr-module/dts/bindings/gpio/virtio,gpio.yaml` — the `virtio,gpio`
  binding (`dts/bindings/gpio/virtio,gpio.yaml` upstream), SHA-256
  `38134b13e4d3e071104b6e337fdfcf942a8a9a1e950c122a07f8cb0b58143880`.

The upstream branch also carries a `tests/drivers/build_all/gpio` entry, which
is not vendored — it tests the driver in the Zephyr tree, not here.

Note that the device this driver talks to is **not** stock QEMU: `hw/virtio/`
ships only `vhost-user-gpio`, a shim onto an external daemon that a
single-process wasm build has no way to run. The browser-backed device model is
the *generic* browser virtio bridge,
`tools/qemu-jit-patches/0010-hw-virtio-add-generic-browser-virtio-bridge.patch`,
whose GPIO device model is TypeScript — `src/virtio/devices/gpio.ts`. See
`docs/virtio-bridge.md`.

### Checking for drift

```console
diff <(gh api "repos/kartben/zephyr/contents/drivers/gpio/gpio_virtio.c?ref=virtio_gpio" --jq .content | base64 -d) \
     zephyr-module/drivers/vendor/gpio_virtio.c
```

### Kconfig symbol collision

`CONFIG_GPIO_VIRTIO` is declared in `zephyr-module/Kconfig` under the *same*
name upstream uses, for the same reason as `CONFIG_VIRTIO_GPU_DISPLAY` above,
and with the same CMake guard — here on
`${ZEPHYR_BASE}/drivers/gpio/gpio_virtio.c`.

## `i2c_virtio.c`

VIRTIO I2C adapter driver (virtio spec 1.3, section 5.16).

| | |
| --- | --- |
| Upstream | <https://github.com/zephyrproject-rtos/zephyr/pull/115003> |
| Commit | `43874a971b86fa517855c43313da677eb4e3449d` — *drivers: i2c: add VIRTIO I2C adapter driver* |
| Path | `drivers/i2c/i2c_virtio.c` |
| SHA-256 | `b0530e3ebb0bbdbd53aa19400eb661ed81e9ddbdee33c293a5b2dc9d00cc57e6` |

Shipped alongside it, also unmodified from the same commit:

- `zephyr-module/dts/bindings/i2c/virtio,i2c.yaml` — the `virtio,i2c`
  binding (`dts/bindings/i2c/virtio,i2c.yaml` upstream),
  SHA-256 `16fdb4f13b81f9513a4c49c95f81bb94fa73e51f26dc5103dc58200395e8b52b`.

This driver was written in this repo first, since Zephyr had no virtio I2C
driver at all, and lived at `zephyr-module/drivers/i2c_virtio.c` until it went
upstream. It is now a pristine copy like the rest, so keep it byte-identical and
send fixes to the PR.

The upstream branch also carries a `tests/drivers/build_all/i2c` entry, which is
not vendored — it tests the driver in the Zephyr tree, not here.

As with GPIO, the device this driver talks to is **not** stock QEMU but the
generic browser virtio bridge, whose I2C device model is TypeScript —
`src/virtio/devices/i2c.ts`. See `docs/virtio-bridge.md`. The request layout that
model decodes (out header, payload, then a 1-byte status) is fixed by the spec,
so re-pinning the driver does not move it.

### Checking for drift

```console
diff <(gh api "repos/kartben/zephyr/contents/drivers/i2c/i2c_virtio.c?ref=claude/virtio-i2c-upstream-pr-ac1160" --jq .content | base64 -d) \
     zephyr-module/drivers/vendor/i2c_virtio.c
```

### Kconfig symbol collision

`CONFIG_I2C_VIRTIO` and `CONFIG_I2C_VIRTIO_MAX_MSGS` are declared in
`zephyr-module/Kconfig` under the *same* names upstream uses, with the same CMake
guard on `${ZEPHYR_BASE}/drivers/i2c/i2c_virtio.c`. `MAX_MSGS` sizes a
per-instance slot array in the driver's data, so a Kconfig that drifts from the
driver's expectations shows up as a build error, not a silent behaviour change.

## `spi_virtio.c`

VIRTIO SPI controller driver (virtio spec 1.4, section 5.21).

| | |
| --- | --- |
| Upstream | <https://github.com/zephyrproject-rtos/zephyr/pull/115010> |
| Commit | `74fd577141bf822e20eb43440fdb3ac0fb53ef09` — *drivers: spi: add VIRTIO SPI driver* |
| Path | `drivers/spi/spi_virtio.c` |
| SHA-256 | `e5b9a411bbe90f08dd0d29e7134170acca951b11f7361b3e47cdfb1214ed6c51` |

Shipped alongside it, also unmodified from the same commit:

- `zephyr-module/dts/bindings/spi/virtio,spi.yaml` — the `virtio,spi`
  binding (`dts/bindings/spi/virtio,spi.yaml` upstream),
  SHA-256 `3450e2876dd50da8df353839c220581341f1b316cb94ff1b3460ba4602d9e303`.

The upstream branch also carries a `tests/drivers/build_all/spi` entry, which
is not vendored — it tests the driver in the Zephyr tree, not here. This repo
needs the driver on `qemu_cortex_a53` / `qemu_riscv32` (virtio-mmio), so it
ships its own snippet at `zephyr-module/snippets/virtio-spi/` and its own
devicetree node in the `browser_bridge` shield. The driver source itself is
architecture-neutral.

As with GPIO, the device this driver talks to is **not** stock QEMU but the
generic browser virtio bridge, whose SPI device model is TypeScript —
`src/virtio/devices/spi.ts`. See `docs/virtio-bridge.md`. The request layout
that model decodes (32-byte head, then TX, then RX, then a 1-byte result) is
fixed by the spec, so re-pinning the driver does not move it.

### Checking for drift

```console
diff <(gh api "repos/kartben/zephyr/contents/drivers/spi/spi_virtio.c?ref=virtio_spi" --jq .content | base64 -d) \
     zephyr-module/drivers/vendor/spi_virtio.c
```

### Kconfig symbol collision

`CONFIG_SPI_VIRTIO` is declared in `zephyr-module/Kconfig` under the *same*
name upstream uses, with the same CMake guard on
`${ZEPHYR_BASE}/drivers/spi/spi_virtio.c`.

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
