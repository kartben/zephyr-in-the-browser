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

## The bridges work inside out

Everything else in the device dock is either a device invented for the browser
or a virtio-mmio bridge, and this machine has neither a virtio bus nor PCI.
Here the peripheral is the SoC's own, modelled in QEMU and driven by the stock
Zephyr driver; what the browser supplies is what would be *wired to it*. The
guest is not aware of any of it, which is the point: nothing is vendored, and
what runs is what would run on the part.

### GPIO

The page reaches the pins through the same two exported functions as the
Cortex-M3's `qemu,host-gpio`, so `src/hostGpio.ts` and the panel serve both
without knowing the difference. `blinky` drives `led0`, and the button is
interrupt-driven rather than polled as on the M3.

### I2C

`hw/i2c/host_i2c.c` is one I2C slave on the controller's bus that answers for
every address the page has a chip at, and `src/hostI2c.ts` is the other end.
The chips are the same TypeScript models the Cortex-A53 reaches over VIRTIO:
`src/virtio/devices/i2c.ts` is a *bus* plus a transport onto it, and this is
the second transport, so an EEPROM, an IMU or an OLED works here without a
line of chip code being repeated. `-S esp32-i2c` is the parts bin (the same
node labels as `-S virtio-i2c`, so the `<part>-only` snippets are shared), and
the browser_bridge shield turns `i2c0` off by default so a sample that does not
ask for the bus does not carry a dock card for it.

Two things cross the boundary through one struct in the wasm heap, whose
address `qemu_host_i2c_area()` exports:

| Offset | Field | Written by | Meaning |
| --- | --- | --- | --- |
| 0x00 | `magic` | QEMU | `0x42433249` (`"I2CB"`) |
| 0x04 | `version` | QEMU | protocol version, currently 1 |
| 0x08 | `present[4]` | page | bit N = a chip answers at 7-bit address N |
| 0x18 | `attached` | page | non-zero while the page is listening |
| 0x1c | `req_seq` | QEMU | bumped after a request is filled in; futex-woken |
| 0x20 | `rsp_seq` | page | set to `req_seq` once answered; futex-woken |
| 0x24 | `op` | QEMU | 1 = write, 2 = read |
| 0x28 | `addr` | QEMU | 7-bit address |
| 0x2c | `len` | QEMU | bytes to write, or to read |
| 0x30 | `flags` | QEMU | bit 0 = this read opens a message |
| 0x34 | `status` | page | 0 = ACK, 1 = NAK |
| 0x3c | `data[4096]` | both | payload, either direction |

Presence is a mask rather than a request because it is asked on every transfer
and 116 times by one `i2c scan`; making that a round trip would have made a
scan the slowest thing on the board. Transfers themselves park the guest's
thread on a futex until the page answers or 250 ms passes, which is a real
blocking wait: a slow browser stalls the guest the way a slow I2C device
would. Nothing re-enters the block layer or a coroutine, which is what makes
that safe from guest context under Asyncify.

The awkward part was read length. Zephyr's driver splits a read of N bytes into
N-1 and 1 so it can NAK the last one, so a *message* is not what the slave
sees; QEMU tells it the length of each run through `i2c_announce_recv()`, and
flags the run that opens a message so a chip whose read position is scoped to a
message (a thermometer restarting at the high byte of its temperature
register) rewinds at the right moment and not between the two halves of its own
register. That is `I2cChip.startRead`, and it is why the page's models needed
no other change.

### SPI

Same arrangement one bus over: `hw/ssi/host_spi.c` is an SSI peripheral on the
GP-SPI2 controller's CS0, `src/hostSpi.ts` is the page's end, and the chips are
the same models the virtio boards use. `-S esp32-spi` turns the controller on
and puts the browser's JEDEC NOR on it, which is what samples/drivers/spi_flash
and samples/subsys/fs/littlefs bind.

The shared area is the I2C one with SPI's fields, at these offsets:

| Offset | Field | Written by | Meaning |
| --- | --- | --- | --- |
| 0x00 | `magic` | QEMU | `0x42535053` (`"SPSB"`) |
| 0x04 | `version` | QEMU | protocol version, currently 1 |
| 0x08 | `present` | page | bit N = the page has a chip on chip select N |
| 0x0c | `attached` | page | non-zero while the page is listening |
| 0x10 | `req_seq` | QEMU | bumped after a request is filled in |
| 0x14 | `rsp_seq` | page | set to `req_seq` once answered |
| 0x18 | `op` | QEMU | 1 = transfer |
| 0x1c | `cs` | QEMU | chip select |
| 0x20 | `len` | QEMU | bytes, the same both ways |
| 0x24 | `flags` | QEMU | bit 0 = the select drops after this run |
| 0x28 | `status` | page | 0 = ok, 1 = error |
| 0x30 | `data[4096]` | both | the run, out and back |

What differs from I2C is the unit. SPI is full duplex, so a byte's answer is
due before the next one goes out and a per-byte round trip would cost an LED
strip frame hundreds of them. The controller knows its run length, so
`ssi_transfer_buffer()` hands the run over whole; a peripheral that does not
implement it is clocked a byte at a time exactly as before. A run is what the
page's chip models already take, `csChange` included, so a flash reading its
status and then its data sees the same sequence it sees over virtio.

One thing is worth knowing before debugging anything here: a chip select the
page has no chip on answers **zero**, not 0xff. That leaves it
indistinguishable from an empty bus, which is what it is. 0xff is not neutral:
a flash driver reads it as a status register with write-in-progress set and
waits for it forever, which hangs the guest before the boot banner.

### CAN

The one bridge with no chip in the middle. TWAI is the SoC's own CAN
peripheral, modelled in QEMU on top of its SJA1000 core, so what the browser
supplies is not a part but the *wire*: `net/can/can_browser.c` puts the page's
bus model (`src/can/bus.ts`) on the other end, and `src/hostTwai.ts` is the
page's half. Where the virtio boards reach CAN through an MCP2515 the page
pretends to be, here the guest drives the silicon with Zephyr's stock
`espressif,esp32-twai` driver. `-S esp32-can` is the whole devicetree job,
because the SoC already chooses that node as `zephyr,canbus`.

Shape differs from I2C and SPI, and has to: a frame arrives because another
node decided to send one, possibly while the guest is idle, so neither side can
be the one that waits. It is a ring pair like the Ethernet netdev, with a
`QEMU_CLOCK_VIRTUAL` timer draining the receive side under the BQL. Records are
a fixed 16 bytes rather than length-prefixed, because a classic CAN frame is an
id, a length and at most eight bytes.

One thing to know before reading a trace: a controller alone on the bus goes
bus-off, and the page models that faithfully. Nothing acknowledges its frames,
its transmit error counter climbs to 256, and the card says `bus-off`. Add a
node from the CAN panel and it recovers. That is the bus behaving correctly,
not the bridge failing.

### Sleep, and the power card

`hw/misc/esp32c3_rtc_cntl.c` models enough of the RTC controller for the part
to sleep: the slow-clock counter, the wake target, and a timer that ends the
sleep. Light sleep gets the wakeup interrupt `rtc_sleep_start()` spins on; deep
sleep gets a reset with reason `DEEPSLEEP_RESET` and no interrupt, because on
hardware the digital core is off and never sees one. That is also why the reset
reason and the RTC scratch registers survive a reset here: it is how a guest
tells a wake from a cold boot.

`src/hostPowerState.ts` and the dock's power card read a small status block the
model keeps. That card is not decoration. Light sleep is otherwise invisible:
the guest stops printing, and nothing distinguishes that from a crash, a busy
loop or a wedged emulator.

## Known limits
- **The only display Zephyr can drive is the OLED.** The machine does map a
  framebuffer at `0x20000000` (`esp_rgb`, plus 8 MB of VRAM), but that is a
  device Espressif invented for their own QEMU rather than anything an
  ESP32-C3 has, and nothing in Zephyr binds it. So `-S oled` is the display
  path here, and accel_chart — which wants 480x320 — has nowhere to draw.
- **The SCT2024 is the one SPI part still missing.** Its latch and
  output-enable lines are bound to the virtio GPIO model rather than to
  whichever controller the board has, so it needs page-side work rather than
  another overlay.
- **Deep sleep does not run to completion.** It hangs in ESP-IDF's power-down
  preparation, before it ever arms the wake timer, so the RTC model is not the
  last piece it needs. Light sleep works, and `samples/boards/espressif/
  light_sleep` is packaged.
- **GP-SPI2 is controller mode only.** Target mode, segmented transfers and the
  GDMA path are not modelled. Zephyr uses the FIFO path when a node has no
  `dma-enabled`, which is what the snippet declares.
- **Pull-ups are the page's job.** The model has no notion of a pad pull-up: an
  input reads whatever was last driven onto it. `src/hostGpio.ts` seeds each
  input to its resting level from the devicetree flags, which is where the
  ESP32-C3 button's pull-up effectively comes from. A native build has nobody
  to do that, so an active-low button there reads as held.
- **`-icount 3` is required.** The C3 has no free-running mode, unlike
  `qemu_riscv32`, which runs free. It rules out the guest-MIPS readout other
  boards use, and it is worth knowing what it does and does not cost, because
  the board *looks* slow and mostly is not.

  Measured in the browser on the shell sample: at an idle prompt the guest
  clock tracks wall clock almost exactly, because icount warps the clock
  forward whenever every vCPU is halted. Under load it does not: a full
  `i2c scan` is **4 ms of guest time** and about **150 ms of wall time**, the
  same 4 ms it takes natively. So compute is roughly 30x slower than real time
  and idle is free, which is why a sample that sleeps between steps feels
  right and one that computes feels sluggish.

  The shift is **not** a throughput lever, which is easy to get wrong. It
  scales how much virtual time an instruction buys, not how fast the emulator
  executes: `-icount 4` was measurably no better, because the same instructions
  still take the same wall time and only the guest's sense of elapsed time
  changes. The lever that would matter is the wasm JIT the Cortex-A53 build
  uses (`ktock/qemu-wasm`'s wasm32 TCG backend); this artifact is built with
  `--enable-tcg-interpreter`, so every guest instruction goes through TCI.
  Putting the JIT under the ESP32 machines means replaying that backend onto
  the espressif fork as well, which is a second rebase of the kind the top of
  this file describes.
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
