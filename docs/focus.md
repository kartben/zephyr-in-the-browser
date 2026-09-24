# Focus: Cortex-A53

For the foreseeable future, **QEMU Cortex-A53** (`qemu_cortex_a53`) is the
primary board. New samples, peripherals, tracing, and debugging work land
there first.

| Why A53 | Detail |
| --- | --- |
| Wasm JIT | Sustained guest throughput; Cortex-M3 stays on TCI |
| Virtio | Full browser_bridge + virtio-mmio device set |
| Tracing | ARM semihosting CTF → in-page Trace panel |
| Default landing | Shell sample on A53 (`DEFAULT_BOARD_ID`) |

Cortex-M3 and `qemu_riscv32` remain packaged where useful, but they are not the
development focus. Tracing variants (`*_trace`) are A53-only — they need
`-semihosting` and `hostTrace`.

## Sample variants (with / without tracing)

Every A53 sample is built twice unless it already embeds CTF in its own
`prj.conf` (`tracing`, `tracing_pipeline`):

| Artifact | Overlays |
| --- | --- |
| `<id>.elf` | `debug-threads.conf` (always) + manifest confs/snippets |
| `<id>_trace.elf` | same, plus snippets `browser-tracing` and (for net samples) `browser-tracing-net` |

The gallery labels the traced twin clearly. Dropped custom ELFs assume tracing
may be present, so Trace (and Debug) open by default.
