# ESP32 in the browser

Two Espressif boards run here, and both boot Zephyr through the real Espressif
first-stage boot ROM out of emulated SPI flash:

- **`esp32c3_devkitc`**: an ESP32-C3 (RISC-V), in the same
  `qemu-system-riscv32` artifact that runs `qemu_riscv32`. This is the developed
  one: four peripherals reach the page and about two dozen samples run.
- **`esp32_devkitc`**: an ESP32 (Xtensa LX6), in a `qemu-system-xtensa`
  artifact of its own. Newer, and further down this file.

Two things make them different from every other board here.

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

Worth sending upstream to Espressif; all of them are fixed in the rebased
branch, and none has been reported yet.

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
- **Neither ESP32 machine connected the GPIO interrupt.** Both realized the
  device and mapped its registers but never called `sysbus_connect_irq`, leaving
  `ETS_GPIO_INTR_SOURCE` unused. Nothing noticed while the controller had no
  state to interrupt from. The symptom once it does have state is quiet:
  `samples/basic/button` prints "Press the button" and then nothing at all,
  however many times the pin is driven, because the guest is waiting on an edge
  that never arrives. Fixed on the C3 first and on the Xtensa ESP32 with it.
- **`qemu_host_gpio_set_inputs()` did not take the BQL**, which only mattered
  once the interrupt above was connected. The page calls it from the browser's
  main thread, which is not a vCPU thread and holds no lock; a pin change can
  raise the controller's interrupt, and delivering one reaches `cpu_interrupt()`,
  which asserts `bql_locked()`. So the first button press aborts the emulator
  outright:

  ```
  ERROR:../qemu/system/cpus.c:268: assertion failed: (bql_locked())
  Bail out!
  ```

  Worth knowing that the C3 survived a press without a lock and the ESP32 did
  not: the Xtensa interrupt matrix routes per-CPU and kicks the vCPU directly.
  That is luck rather than a real difference, since both machines reach the same
  function from the same thread.

  The fix is *not* to take the BQL there, which was tried and is worse. It stops
  the assertion, and it also blocks the browser's main thread inside
  `bql_lock()`; the page makes one of these calls at attach, while QEMU is still
  bringing the machine up and holding the lock across most of that, so the boot
  never finishes. Three boots in a row stopped at "Adding SPI flash device".
  Instead the page records the value and a `QEMU_CLOCK_VIRTUAL` timer applies it
  from QEMU's side, where the BQL is already held.
- **`MAX_CALL_IARGS` was not raised for `DEF_HELPER_8`.** The fork adds
  `DEF_HELPER_8` and `tcg_gen_call8` but leaves `MAX_CALL_IARGS` at 7, which
  `tci.c` uses to size `call_slots[]`. Only `target/xtensa/helper.h` uses it, so
  it does not affect the RISC-V artifact, but a TCI or wasm Xtensa build trips
  `assert(nargs <= MAX_CALL_IARGS)`.
- **`esp32_flash_enc.c` includes `<gcrypt.h>` unconditionally.** Its one gcrypt
  call site is already behind `#ifdef CONFIG_GCRYPT`, with a `QCryptoCipher`
  fallback immediately below it, so the include is the only thing that was
  missing. It is in the unconditional `CONFIG_XTENSA_ESP32` file list, so
  `--disable-gcrypt` fails to compile the machine at all.
- **The ESP32 machine instantiates `TYPE_ESP32_RSA` unconditionally**, while
  `hw/misc/meson.build` only compiles `esp32_rsa.c` under `if gcrypt.found()`.
  Without gcrypt the machine aborts at startup with
  `unknown type 'misc.esp32.rsa'`. `esp32c3.c` already guards its own RSA and
  AES and drops an unimplemented-device stub in their place; this is the same
  treatment one machine over. (`esp32_aes.c` needs no guard: it is in the
  unconditional list and does not touch gcrypt.)
- **`XTENSA_ESP32` under-declares its Kconfig `select`s too**, the same bug as
  the C3's, just with a different set: the machine uses `CAN_SJA1000`
  unconditionally and never selects it, and it selected `TMP105` only for a demo
  thermometer soldered on at a fixed address.

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

Deep sleep needed one more register, and finding it is the useful part of the
story. The guest reached "Powering off" and hung, and the RTC model was not
what it was missing: `info registers` on the QEMU monitor showed the PC pinned
at a fixed ROM address across repeated samples, and the four instructions
around it decoded to "set bit 8, spin until bit 31, clear bit 8" against a base
of `0x600c0000`. That identified it by offset alone:
`SYSTEM_RTC_FASTMEM_CONFIG`, where the ROM computes a CRC over RTC fast memory
so it can tell on the way back out that the wake stub survived. Nothing modelled
it, so the finish bit never arrived. Memory does not decay under emulation, so
the check exists only to be passed: finish immediately and leave the digest
alone.

## Known limits (ESP32-C3)
- **The only display Zephyr can drive is the OLED.** The machine does map a
  framebuffer at `0x20000000` (`esp_rgb`, plus 8 MB of VRAM), but that is a
  device Espressif invented for their own QEMU rather than anything an
  ESP32-C3 has, and nothing in Zephyr binds it. So `-S oled` is the display
  path here, and accel_chart — which wants 480x320 — has nowhere to draw.
- **The SCT2024 is the one SPI part still missing.** Its latch and
  output-enable lines are bound to the virtio GPIO model rather than to
  whichever controller the board has, so it needs page-side work rather than
  another overlay.
- **Sleep is timer-wakeup only.** Both `light_sleep` and `deep_sleep` are
  packaged and run, but the RTC model arms nothing else: GPIO, touch and UART
  wake sources are not there, and a sleep with no timer armed is rejected
  rather than entered.

  **A sleep costs its own duration times how far behind real time this machine
  runs**, which is the ~30x above: the guest spins in `rtc_sleep_start()`
  waiting for a wake it cannot reach on its own, and under `-icount` every
  microsecond of that wait is emulated instruction by instruction. Five seconds
  of deep sleep is about two minutes of wall clock in the browser, which is why
  the packaged sample asks for one second.

  Halting the vCPU is the obvious fix and it works beautifully *natively* -
  light sleep went from 55 cycles to 245 in the same wall time, because a
  halted CPU lets the icount clock warp straight to the wake timer. It was
  tried and reverted, because the wasm build never advances the icount clock
  while the vCPU is halted: the wake is then never reached at all, and a deep
  sleep that took two minutes before simply never returned. `sleep=off` on the
  icount argument makes no difference. Uniformly slow beats fast natively and
  broken in the artifact that ships.
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
- **The ESP32-S3 is compiled in but has no board.** `xtensa-softmmu` carries
  `esp32s3` alongside `esp32` because dropping it would save little and the
  models are already there, but nothing in `src/boards.ts` or
  `tools/samples.manifest` selects it and it has not been booted here.
## The Xtensa board

`esp32_devkitc` is the ESP32 proper: two Xtensa LX6 cores where the C3 has one
RISC-V, and the same story everywhere else. It boots the same way (Espressif
boot ROM, merged image in emulated SPI flash), from the same fork, with the same
`browser_bridge` shield deciding which nodes a sample gets.

What is genuinely different is worth knowing before touching it.

### It is a fourth binary

The Xtensa machines exist in no other target, so unlike `esp32c3`/`esp32c6`
riding along in `qemu-system-riscv32`, this is its own `qemu-system-xtensa`:
**7.7 MB of wasm**, downloaded only by someone who picks the board. The
`riscv32` artifact is untouched and nobody else pays for this.

`tools/build-qemu-wasm.sh` builds it from the *same* `$WORK/qemu-esp` tree as
`riscv32-softmmu`, applying the same `tools/qemu-esp-patches/` series. Most of
that series wires `hw/riscv/virt.c`, which an Xtensa build simply does not
compile; what it needs out of it is the xterm-pty link, the link optimisation
and the browser chardevs. Taking the series whole is deliberate: two series
against one working tree would fight, because `apply_local_patches` restores the
tree with `git checkout --force` before every build.

`configs/devices/xtensa-softmmu/browser.mak` trims the target to the two ESP32
machines. Dropping `XTENSA_VIRT` is the one that pays: it selects the PCI
Express bridge and the PCI device catalogue, for a pair of machines with no PCI
bus at all.

### Two ROMs and an eFuse image

The part is dual-core and each core enters a different ROM image, so the datadir
carries `esp32-v3-rom.bin` *and* `esp32-v3-rom-app.bin` rather than the C3's
single file. Both are found by name through `qemu_find_file()`, so `-L
/pack/pc-bios` is what puts them in reach.

Then there is a third file, and it is the one that is easy to lose a morning to.
Out of the box the ROM prints `chip revision: v0.0` and ESP-IDF's boot stub
stops: *"You are using ESP32 chip revision (0) that is unsupported."* Nothing is
wrong with the image; the machine simply reports an unfused part.

ESP-IDF reads the revision as three bits ORed together: `CHIP_VER_REV1` and
`CHIP_VER_REV2` out of eFuse BLK0 (bits 111 and 180, so word 3 bit 15 and word 5
bit 20), plus `APB_CTRL_DATE_REG` bit 31, which `hw/xtensa/esp32.c` already
asserts. All three set is revision 3, ECO3. So the eFuse image is 124 bytes of
which two bits matter, and `tools/build-qemu-wasm.sh` writes it rather than
carrying a blob in git, because a blob would say nothing about which two.

### The button, and a lock the bridge was missing

The BOOT button is worth calling out because getting it working took two fixes,
not one, and the second only became reachable after the first. Connecting the
GPIO interrupt (see the fork-bug list above) turned "the press does nothing"
into "the press aborts QEMU on a BQL assertion", because the page drives pins
from a thread that holds no lock and an interrupt delivery wants one. Both fixes
are in the fork; the second lives in the shared bridge because the requirement
is not ESP32-specific, even though only the ESP32 tripped it.

The lesson for the next bridge that pushes state *into* the guest rather than
answering a request from it: a browser callback is not a vCPU thread, and the
answer is not to make it act like one. Taking the BQL from the page deadlocks
against QEMU's own startup. Have the page publish a value and let something on
QEMU's side pick it up under a lock it already holds, which is what
`net/can/can_browser.c` does with a ring and a timer and what the GPIO bridge
now does with a word and a timer.

The three bridges that answer *requests* (I2C, SPI, and the output half of
GPIO) need none of this, because the guest is the one that starts the exchange
and QEMU is already on a thread entitled to touch device state.

### The bridges are wired but not yet reachable

`hw/i2c/host_i2c.c`, `hw/ssi/host_spi.c` and `net/can/can_browser.c` are all
SoC-agnostic, and the ESP32's own controllers are the models the C3's subclass,
so wiring them into `hw/xtensa/esp32.c` was the C3's blocks almost line for
line: the browser I2C slave on `i2c0`, one `qemu-host-spi` per HSPI chip select
(all three), and a CAN bus linked before the TWAI is realized.

They are in the artifact and confirmed present (`info qom-tree` shows the slave,
three SSI peripherals and the bus). What is *not* done is the Zephyr side: no
`esp32-i2c` / `esp32-spi` / `esp32-can` snippet lists this board yet, and no
manifest row asks for one. That is per-board overlay work, not model work, and
it is the obvious next step.

Two details differ from the C3 and are already handled:

- HSPI (`spi2`) carries the browser's chip selects rather than the C3's GP-SPI2,
  and there is no equivalent of `-machine esp32c3,host-spi-cs=0`. It is not
  needed: SPI1 already carries the real flash and VSPI (`spi3`) is left entirely
  free for a QEMU device.
- The I2C slave replaced a `tmp105` this machine used to solder on at 0x48. A
  device at a fixed address is the wrong shape here, because `host_i2c.c`
  answers for every address the page says it has a chip at, and the page models
  thermometers among much else, so a hardcoded one would collide.

### The icount shift, and why it stays at 3

The C3 runs at `-icount 3` and the shift is not a throughput lever there. Here
it is, and by a lot, because the ESP32 boot ROM is mostly fixed-duration
spin-waits: a wait reaches its deadline in half the instructions each time the
shift goes up. Measured natively under TCI, to the Zephyr banner:

| `-icount` | ns/insn | apparent clock | boot |
| --- | --- | --- | --- |
| 3 | 8 | 125 MHz | 3.5 s |
| 4 | 16 | 62 MHz | 1.9 s |
| 5 | 32 | 31 MHz | 1.1 s |
| 6 | 64 | 16 MHz | 0.7 s |
| 7 | 128 | 8 MHz | 0.4 s |

It keeps halving, so the stopping point is not performance but plausibility: the
shift is also what the guest reads as its own clock. 5 would put it at ~31 MHz,
low for a part that runs at 240 MHz; two more shifts would buy another 2.5x and
claim 8 MHz.

The board ships at 3 anyway, because **none of that showed up in the browser**,
which is the artifact that matters. A shell prompt takes roughly a minute and a
half there either way, against 1 to 4 seconds natively, so whatever dominates
the wasm build is not the ROM's instruction count. The likely suspect is already
written down two sections up: this build never advances the icount clock while
the vCPU is halted, which is what killed the halt-on-sleep experiment too. If
someone fixes that, re-measure this table in the browser before touching the
shift; until then a faithful 125 MHz beats an unfaithful 31 MHz that buys
nothing.

`-smp 1` is not an option, tempting as it looks for a unicore Zephyr build: the
machine takes `ms->smp.cpus` in some loops and `ESP32_CPU_COUNT` in others, and
with one CPU it never reaches the banner at all.

### Registers, and what the Debug panel can do

QEMU's Xtensa gdbstub serves **no** `target.xml`, so the `g` packet layout is
not discoverable at runtime: it is whatever `core-esp32/gdb-config.inc.c`
declares, minus the entry types `xtensa_count_regs()` skips (window, mapped,
unmapped, TIE state). That is 157 registers and exactly 628 bytes, which matches
what the stub sends. `src/debug/gdb/regs.ts` hardcodes the offsets that matter:
pc at 0, the 64-entry physical register file at 4, then `windowbase` at 276,
`windowstart` at 280 and `ps` at 292.

Two things about that file are Xtensa-specific and both are load-bearing:

- **The packet carries physical registers, not `a0..a15`.** Those are a rotating
  view, so the ABI's stack pointer is `ar[(windowbase * 4 + 1) % 64]`. A decoder
  that read `ar1` would be right only when `windowbase` happened to be 0.
- **A windowed return address is not an address.** `call4`/`call8`/`call12` put
  the window increment in the top two bits of `a0` and drop the top two bits of
  the address, which the return reconstructs from the current PC. Undo that or
  nothing resolves against the symbol table.

Verified against a real stop: PC in `arch_cpu_idle`, reconstructed return
address nine bytes into `idle`, which is the call the idle thread actually made.

The call stack falls back to a stack scan here rather than walking frame
records, and that is correct: the windowed ABI spills a caller's registers below
its own stack pointer instead of threading a `{caller fp, return}` record
through a fixed register, so there is no chain. `decodeXtensa` returns a null
frame pointer for exactly that reason, which is what sends `unwindStack` to the
scan. The spill area is full of saved `a0` values, so the scan finds real
callers.
