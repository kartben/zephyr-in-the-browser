# The A53 accelerometer_chart crash was a stack overflow, not a JIT bug

A note recording what looked like a wasm-JIT miscompilation but turned out to be
an ordinary guest stack overflow — kept because the misleading evidence is worth
recognising the next time an A53 sample dies in the browser.

## Symptom

On `qemu_cortex_a53`, the `accelerometer_chart` sample used to die the first time
its LVGL timer callback took the error path. The trigger was a driver gap: the
host-sensor driver did not answer `SENSOR_CHAN_ACCEL_XYZ`, so
`sensor_channel_get()` returned `-ENOTSUP` (`-134`), the callback ran
`LOG_ERR("... Update failed: %d", rc)`, and the guest immediately took a fatal
exception:

```
<err> app: ERROR: Update failed: -134
<err> os: ESR_ELn: 0x0000000082000006   (Instruction Abort from a lower EL)
<err> os: FAR_ELn: 0x0000000000000000   (fetch from address 0)
<err> os: x16: 0x0000017c0000024c  x17: 0x0000018e0000024c
<err> os: lr:  0x0000001300000001
<err> os: >>> ZEPHYR FATAL ERROR 0: CPU exception on CPU 0
```

Two things made this look like an emulator codegen bug. The program counter was
`0`. And several registers held values that are *architecturally impossible* as
the result of a 32-bit operation: `x16`/`x17`/`lr` all carry non-zero junk in
their upper 32 bits, when a `Wn` write must zero bits [63:32]. That is exactly
the fingerprint you would expect from a wasm32 backend that forgot to
zero-extend — and this JIT family has a documented history of miscompiling hot
blocks (see `public/qemu/README.md`, which keeps the Cortex-M JIT on the
interpreter for that reason). So the first hypothesis was a JIT miscompile.

It was wrong.

## What it actually was

`>>> ZEPHYR FATAL ERROR 2: Stack overflow on CPU 0`.

The `accelerometer_chart` sample ships `CONFIG_MAIN_STACK_SIZE=4096`, a value
tuned for the 32-bit `native_sim` host it targets upstream. On the 64-bit
`qemu_cortex_a53`, 4 KB is too tight. The main thread runs `lv_timer_handler()`,
and LVGL's frames plus the deferred `cbprintf` packaging that `LOG_ERR` performs
overran the stack. The overrun corrupted memory just below the stack; the
"impossible" registers were simply two adjacent 32-bit stack words read back as
one 64-bit value, and the `PC=0` abort was a `blr` through a clobbered function
pointer. Nothing in the emulator misbehaved.

## How the evidence was disambiguated

Everything was reproduced in the browser on the A53 JIT emulator with the
driver's `SENSOR_CHAN_ACCEL_XYZ` handling temporarily reverted to force the
`-ENOTSUP` path.

- **`CONFIG_LOG_MODE_IMMEDIATE`** — still crashed, with *byte-identical* garbage
  registers across a different binary layout. Suggestive of determinism, but
  equally explained by the overflow reading the same fixed LVGL heap data.
- **`CONFIG_MAX_XLAT_TABLES` bump** — no effect. The boot warning
  "xlat tables low: 7 of 8 in use" is unrelated (7 of 8 is not exhaustion).
- **`CONFIG_MAIN_STACK_SIZE=16384`** — crash gone. The fatal behaviour was
  sensitive to stack *size*, the first real clue.
- **`CONFIG_STACK_SENTINEL` at 4 KB** — the decider. The wild `PC=0` abort turned
  into a clean, self-identified `FATAL ERROR 2: Stack overflow`, with a register
  (`x17`) pointing *below* the main-stack limit. Definitive.
- **Upstream TCI build** (`QEMU_AARCH64_ACCEL=tci`) — a red herring worth noting.
  The same ELF crashed under the interpreter too, but *earlier and differently*:
  a synchronous external abort reading the host-sensor MMIO at `0x90c0000` during
  `qhs_init`, with a perfectly clean register file. The upstream/TCI host-sensor
  device does not respond at that address (its patch wires the device differently
  from the JIT fork's), so TCI never reaches the timer path at all. Its clean
  registers say nothing about the overflow one way or the other.

The stack-size sensitivity plus the sentinel verdict rule the emulator out: a
guest stack overflow uses the same stack whatever runs it, and no codegen bug
corrupts a software sentinel word.

## The fix

Give the sample real stack headroom. `zephyr-module/conf/lvgl-accel.conf` sets
`CONFIG_MAIN_STACK_SIZE=8192` and is applied to the A53 `accel_chart` build in
`tools/samples.manifest`. 8 KB clears the worst case — a `LOG_ERR` on every timer
tick — with margin: with the sentinel on, that build runs indefinitely instead
of overflowing in 40 ms.

The driver gap that pulled the trigger is independently fixed (the host-sensor
driver now answers `SENSOR_CHAN_ACCEL_XYZ`), so the shipped sample never takes
the error path. The stack bump is defence in depth against the underlying
fragility.

## Lesson for the next sample

Upstream samples size `CONFIG_MAIN_STACK_SIZE` for whatever host they document,
often 32-bit `native_sim`. A 64-bit `qemu_cortex_a53` guest has larger frames,
and anything that logs from a hot path adds a stack-hungry `cbprintf`. When an
A53 sample dies with a wild `PC` and nonsense registers, enable
`CONFIG_STACK_SENTINEL` before blaming the JIT — it will tell you in one line
whether it is a stack overflow. `lvgl_music` is another LVGL sample on this board
worth keeping an eye on if it ever grows a hot logging path.
