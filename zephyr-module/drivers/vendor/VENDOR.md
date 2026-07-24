# Vendored upstream sources

Files here are **pristine copies** of code that is not yet in the Zephyr tree
this repo builds against. They are byte-identical to their upstream revision so
that drift is a one-line `diff` away, and they carry their original copyright
headers. Everything else under `zephyr-module/` is this repo's own code.

Each entry is retired — deleted, along with its Kconfig and the CMake guard
that builds it — as soon as the upstream commit lands in mainline Zephyr.

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
| SHA-256 | `365bf14cf8d54fe0445df828778e49703c0fa50ed022486a4bd4cc729a3918b8` |

Shipped alongside it, also unmodified from the same commit:

- `zephyr-module/dts/bindings/gpio/virtio,gpio.yaml` — the `virtio,gpio`
  binding (`dts/bindings/gpio/virtio,gpio.yaml` upstream), SHA-256
  `a984889121d878e7968e425eec6caf5a584f40261399faf42ea2ddaa2d98ed2e`.

The upstream branch also carries a `tests/drivers/build_all/gpio` entry, which
is not vendored — it tests the driver in the Zephyr tree, not here.

Note that the device this driver talks to is **not** stock QEMU: `hw/virtio/`
ships only `vhost-user-gpio`, a shim onto an external daemon that a
single-process wasm build has no way to run. The browser-backed device model is
`tools/qemu-jit-patches/0010-hw-virtio-add-browser-backed-virtio-gpio.patch`.

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
