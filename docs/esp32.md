# ESP32 in the browser

The `esp32c3_devkitc` board boots Zephyr on an emulated ESP32-C3, through the
real Espressif first-stage boot ROM, in the same `qemu-system-riscv32` artifact
that runs `qemu_riscv32`.

Two things make it different from every other board here.

## The emulator comes from a fork

Upstream QEMU has no ESP32 machines at all: `hw/xtensa/` ships `sim`, `virt` and
`xtfpga`, and there is nothing for the RISC-V parts. The models live only in
[espressif/qemu](https://github.com/espressif/qemu), whose `esp-develop` branch
is **126 commits and 277 files on top of v9.2.2**.

That version is the problem. Upstream gained Emscripten support in 10.x
(`configs/meson/emscripten.txt`), which is why `tools/build-qemu-wasm.sh` can
build v10.1.0 to wasm at all; 9.2.2 predates it, and espressif/qemu has no
emscripten support of its own. So the delta is replayed onto v10.1.0 rather than
the wasm port being backported to 9.2.2.

`tools/build-qemu-wasm.sh` builds `riscv32-softmmu` from that rebased tree,
pinned with `QEMU_ESP_REPO` / `QEMU_ESP_REF`, in its own `$WORK/qemu-esp`
directory. `arm-softmmu` and `aarch64-softmmu` are untouched and still build
from upstream and from `ktock/qemu-wasm` respectively.

Replaying it is cheaper than "126 commits" suggests: 234 of the 277 files are
*added*, so checking out v10.1.0 and overlaying them leaves only 42 modified
files to reconcile, of which 35 applied unchanged. The rest was 9.2 to 10.1 API
churn (`sysemu/` becoming `system/`, `const` on `class_init` data, the removal of
`DEFINE_PROP_END_OF_LIST`, the `exec/exec-all.h` split, `riscv_csr_write_fn`
gaining a return-address argument, `CPUClass::has_work` moving into the const
`SysemuCPUOps` table).

### Bugs found in the fork

Worth sending upstream to Espressif; all four are fixed in the rebased branch.

- **`RISCV_ESP32C3` / `C6` under-declare their Kconfig dependencies.** They
  select `OPENCORES_ETH` and `UNIMP` but not `SSI`, `SSI_M25P80` or
  `CAN_SJA1000`, which `esp32c3_spi.c` and `esp32c3_twai.c` need.
  `XTENSA_ESP32` gets this right. It only shows up with a trimmed device config
  like `browser.mak`: espressif's all-boards `default.mak` pulls the same code
  in through other machines, so their own builds link.
- **`esp_sha_algs[]` casts the hash functions to the wrong type.**
  `sha224/sha256/sha512_compress()` return `int`, and the table casts them to
  `hash_compress`, which is `void (*)(void *, const uint8_t *)`. Calling through
  a mismatched function pointer is undefined behaviour that native targets
  tolerate, and the cast also hides it from
  `-Wincompatible-function-pointer-types`. WebAssembly type-checks every
  `call_indirect`, so this traps with `function signature mismatch` the moment
  the guest drives the SHA accelerator, which the boot ROM does to verify the
  image it just loaded.
- **The slirp wrapper breaks `--disable-slirp`.** `meson.build` wraps slirp in
  `declare_dependency()` unconditionally as a Windows static-linking workaround.
  `declare_dependency()` always returns a found object, so `slirp.found()` is
  true under `-Dslirp=disabled` and `net/slirp.c` compiles without `libslirp.h`.
- **The GPIO controller was a strapping stub.** `esp32_gpio`'s write handler was
  empty and the only readable register was the boot strapping value, so a guest
  could configure an output, drive it, and read back nothing. It exists to
  answer one read from the boot ROM. The low bank is now modelled properly
  (OUT/ENABLE/IN/STATUS and the per-pin interrupt configuration), which the
  ESP32 and the RISC-V parts share; only the per-pin block and the CPU
  interrupt register move, so those became class fields.
- **The C3 machine never connected the GPIO interrupt.** It realized the device
  and mapped its registers but never called `sysbus_connect_irq`, leaving
  `ETS_GPIO_INTR_SOURCE` unused. Nothing noticed while the controller had no
  state to interrupt from.
- **`MAX_CALL_IARGS` was not raised for `DEF_HELPER_8`.** The fork adds
  `DEF_HELPER_8` and `tcg_gen_call8` but leaves `MAX_CALL_IARGS` at 7, which
  `tci.c` uses to size `call_slots[]`. Only `target/xtensa/helper.h` uses it, so
  it does not affect the RISC-V artifact, but a TCI or wasm Xtensa build would
  trip `assert(nargs <= MAX_CALL_IARGS)`.

Also carried, and specific to running in a browser: `esp32c3_cache.c` filled its
cache with a synchronous `blk_pread()` from the MMIO handler that guest MMU
writes land in. Reading the image once at realize and serving fills from memory
keeps block I/O out of guest execution, which matters more under Asyncify
coroutines than it does natively.

## The guest boots from flash, not from `-kernel`

Every other board is loaded with `-kernel <app>.elf`. An ESP32 boots its ROM,
which reads a merged image out of emulated SPI flash, so the board is
`-drive file=/pack/flash.bin,if=mtd,format=raw` instead, and
`tools/build-zephyr-image.sh` emits `<app>.flash.bin` next to the ELF.

**No Zephyr patch is involved**, and in particular
[PR #116814](https://github.com/zephyrproject-rtos/zephyr/pull/116814) is not
vendored. That PR teaches Zephyr to launch a *host* Espressif QEMU through
`west build -t run`, which this project never calls. The only part worth having
is the flash-image merge, and a stock `esp32c3_devkitc` build already publishes
everything it needs: `soc/espressif/common/CMakeLists.txt` feeds the partition
offset and flash size through `board_runner_args()`, so they arrive in
`build/zephyr/runners.yaml` as `--esp-app-address` and `--esp-flash-size`.

The merge itself is what `esptool merge-bin --pad-to-size` produces for a Simple
Boot image, byte for byte: the app placed at its offset in an erased (`0xFF`)
image of the board's flash size. The build script does it in Python so the step
needs no esptool in either the native or the container path.

The ELF is still shipped and still preloaded, so the debugger can resolve
`CONFIG_DEBUG_THREAD_INFO` symbols out of it as on every other board. It is just
not what boots.

## Known limits

- **GPIO is the only peripheral bridged, and it works differently from the
  others.** Everything else in the device dock is either a device invented for
  the browser or a virtio-mmio bridge, and this machine has neither a virtio bus
  nor PCI. GPIO instead is the SoC's own controller, modelled in QEMU and driven
  by the stock Zephyr esp32 driver: nothing is vendored, and the guest is not
  aware it is emulated. The page reaches it through the same two exported
  functions as the Cortex-M3's `qemu,host-gpio`, so `src/hostGpio.ts` and the
  panel serve both without knowing the difference. `blinky` drives `led0`, and
  the button is interrupt-driven rather than polled as on the M3.
- **I2C and SPI are not reachable.** Zephyr's `i2c0` sits at `0x60013000` with
  nothing mapped behind it, and the only I2C model in the fork is the Xtensa
  ESP32's. `spi2` at `0x60024000` is likewise unmodelled; the only SPI
  controller is `spi1`, which carries the flash. Both are new QEMU device
  models rather than bridge work.
- **Pull-ups are the page's job.** The model has no notion of a pad pull-up: an
  input reads whatever was last driven onto it. `src/hostGpio.ts` seeds each
  input to its resting level from the devicetree flags, which is where the
  ESP32-C3 button's pull-up effectively comes from. A native build has nobody
  to do that, so an active-low button there reads as held.
- **`-icount 3` is required.** The C3 has no free-running mode. It caps
  throughput and rules out the guest-MIPS readout other boards use.
- **Cost to the shared artifact: +0.24 MB (+2.8%)**, 8.77 MB to 9.01 MB, for both
  `esp32c3` and `esp32c6`. Carrying them in the existing `qemu-system-riscv32`
  rather than a second binary keeps `Board.qemuBinary` and the asset probe
  unchanged, since the Emscripten `.js` glue hardcodes its own `.wasm` name and
  a second riscv32 build cannot simply be renamed on install.
- **Xtensa is ported but not shipped.** The same tree builds a
  `qemu-system-xtensa` with `esp32` and `esp32s3` that boots
  `esp32_devkitc/esp32/procpu` natively, including the ECO3 eFuse image the
  guest needs to report rev v3.0. Shipping it needs a fourth entry in
  `tools/package-emulator.sh`, the `xtensa-espressif_esp32_zephyr-elf` toolchain
  in CI, the `MAX_CALL_IARGS` fix above, and an ELF-machine-94 decoder in
  `src/debug/gdb/regs.ts`, which returns `null` for Xtensa today.
