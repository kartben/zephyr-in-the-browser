# Vendored upstream sources

Files here are mostly **pristine copies** of code that is not yet in the Zephyr
tree this repo builds against (byte-identical to an upstream revision so drift
is a one-line `diff` away). `auxdisplay_gpio_7seg.c` is the exception: it is a
deliberate fix of an in-tree ISR misuse — see that section. Everything else
under `zephyr-module/` is this repo's own code.

Each pristine entry is retired — deleted, along with its Kconfig and the CMake
guard that builds it — as soon as the upstream commit lands in mainline Zephyr.
`virtio_blk.c` has one extra thing to delete with it: see its section below.

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

VIRTIO GPIO driver (virtio spec 1.3, section 5.16).

| | |
| --- | --- |
| Upstream | <https://github.com/zephyrproject-rtos/zephyr/pull/114423> (draft) |
| Commit | `92dacf42802bc5f8d090166ddc6d87627bbb7482` — *drivers: gpio: add VIRTIO GPIO driver* |
| Path | `drivers/gpio/gpio_virtio.c` |
| SHA-256 | `70fc6c6889acc064a0863b85e77b8b3c3c30f623c2bebe6d83758041d1ab84c2` |

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
diff <(gh api "repos/kartben/zephyr/contents/drivers/gpio/gpio_virtio.c?ref=claude/virtio-gpio-driver-9a5e5a" --jq .content | base64 -d) \
     zephyr-module/drivers/vendor/gpio_virtio.c
```

### Kconfig symbol collision

`CONFIG_GPIO_VIRTIO` is declared in `zephyr-module/Kconfig` under the *same*
name upstream uses, for the same reason as `CONFIG_VIRTIO_GPU_DISPLAY` above,
and with the same CMake guard — here on
`${ZEPHYR_BASE}/drivers/gpio/gpio_virtio.c`.

## `spi_virtio.c`

VIRTIO SPI controller driver (virtio SPI controller device, ID 45).

| | |
| --- | --- |
| Upstream | <https://github.com/kartben/zephyr/pull/469> |
| Commit | `b41b55d7a6e50bf272eb249cb95c8ce17e9574d6` — *drivers: spi: add virtio SPI controller driver* |
| Path | `drivers/spi/spi_virtio.c` |
| SHA-256 | `906d17b2d90d3f815aa6d2c2491884276078a6afd8f6925b043e63355b638e88` |

Shipped alongside it, also unmodified from the same commit:

- `zephyr-module/dts/bindings/spi/virtio,spi.yaml` — the `virtio,spi`
  binding (`dts/bindings/spi/virtio,spi.yaml` upstream),
  SHA-256 `7e0ae0c6f848d3166b89ecceb5ccc04ac44258b8016d01574c1725f6757618b0`.

The upstream branch also carries board enablement for `qemu_x86`; this repo
needs the driver on `qemu_cortex_a53` / `qemu_riscv32` (virtio-mmio), so it
ships its own snippet at `zephyr-module/snippets/virtio-spi/` and its own
devicetree node in the `browser_bridge` shield. The driver source itself is
architecture-neutral.

### Checking for drift

```console
diff <(gh api "repos/kartben/zephyr/contents/drivers/spi/spi_virtio.c?ref=claude/virtio-spi-driver-l5hpsb" --jq .content | base64 -d) \
     zephyr-module/drivers/vendor/spi_virtio.c
```

### Kconfig symbol collision

`CONFIG_SPI_VIRTIO` is declared in `zephyr-module/Kconfig` under the *same*
name upstream uses, with the same CMake guard on
`${ZEPHYR_BASE}/drivers/spi/spi_virtio.c`.

## `virtio_blk.c`

VIRTIO block device driver, behind Zephyr's Disk Access API.

| | |
| --- | --- |
| Upstream | <https://github.com/zephyrproject-rtos/zephyr/pull/112581> |
| Commit | `d1f7fdff2cd87999b5f1996e30582653905b8e11` — *drivers: disk: add virtio-blk driver* |
| Path | `drivers/disk/virtio_blk.c` |
| SHA-256 | `e7e48a92ccd50ef69c25a74e2e2bc6114a28ac8cf5fd67a2ebe2aacc14cc832f` |

Shipped alongside it, also unmodified from the same commit:

- `zephyr-module/dts/bindings/disk/virtio,blk.yaml` — the `virtio,blk`
  binding (`dts/bindings/disk/virtio,blk.yaml` upstream), SHA-256
  `1010392c2045ae84384256a742a12b966ac0fd792139eb97d1e9f95a31553a5c`.

Unlike every other virtio driver here, the device this one talks to **is**
stock QEMU: `virtio-blk-device` and the whole block layer are already linked
into the packaged emulators, so this needed no qemu-wasm rebuild and there is
no page-side device model. The backing store is a raw image the page allocates
in the Emscripten filesystem — see the `virtio_blk` sample's `extraArgs` /
`blankFiles` in `src/boards.ts`.

The PR also carries board enablement (`boards/qemu/cortex_a53/board.cmake`,
`cmake/emu/qemu.cmake`, a `qemu-img` disk-creation step) and tests. None of
that is vendored: this repo attaches the device from `src/boards.ts` and
creates the image in the page.

### Checking for drift

```console
diff <(gh api "repos/hongquan-prog/zephyr/contents/drivers/disk/virtio_blk.c?ref=virtio-blk-split" --jq .content | base64 -d) \
     zephyr-module/drivers/vendor/virtio_blk.c
```

### Kconfig symbol collision

`CONFIG_DISK_DRIVER_VIRTIO_BLK`, `CONFIG_DISK_VIRTIO_BLK_MAX_SEGMENTS` and
`CONFIG_DISK_VIRTIO_BLK_SECTOR_SIZE` are declared in `zephyr-module/Kconfig`
under the *same* names upstream uses, with the same CMake guard on
`${ZEPHYR_BASE}/drivers/disk/virtio_blk.c`. Upstream sources its
`Kconfig.virtio_blk` from inside `if DISK_DRIVERS`; the copy here reproduces
that with an explicit `depends on DISK_DRIVERS`.

### The one thing that is *not* vendored: the FatFS volume string

Upstream also patches `modules/fatfs/zephyr_fatfs_config.h` to add

```c
DT_FOREACH_STATUS_OKAY(virtio_blk, _FF_DISK_NAME)
```

to `FF_VOLUME_STRS`, so that FatFS knows the disk's name. That file is in the
Zephyr tree, and an out-of-tree module cannot reach it.

Zephyr already ships an escape hatch for exactly this, and
`zephyr-module/conf/virtio-blk.conf` uses it:

```
CONFIG_FS_FATFS_CUSTOM_MOUNT_POINT_COUNT=1
CONFIG_FS_FATFS_CUSTOM_MOUNT_POINTS="VIRTIOBLK0"
```

`fatfs_init()` splits that string into the same `VolumeStr[]` array that
`modules/fatfs/zfs_diskio.c` indexes to get the name it hands to
`disk_access_*` — so the result is identical to upstream's generated list, for
this one disk. Delete those two lines together with this driver.

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
