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
