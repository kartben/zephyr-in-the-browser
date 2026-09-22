# Watchdogs

`samples/drivers/watchdog` runs, unmodified, on three boards, and the dock's
watchdog card counts it down on each. The watchdog is always the machine's own
hardware, driven by Zephyr's stock driver; nothing about it is invented for the
browser except the window the page looks through.

| Board | Watchdog | Zephyr driver | Stages | Callback |
| --- | --- | --- | --- | --- |
| `esp32c3_devkitc` | TIMG0's MWDT | `espressif,esp32-watchdog` | interrupt, then reset | runs |
| `qemu_cortex_m3` | LM3S6965 watchdog (QEMU's `luminary-watchdog`) | `arm,cmsdk-watchdog` | interrupt, then reset | never runs |
| `qemu_riscv32` | SiFive E always-on block, added to `virt` | `sifive,wdt` | reset | not reached |

The ESP32-C3's board devicetree already enables its watchdog. The other two
get theirs from `-S watchdog`, which turns on a node the browser_bridge shield
declares disabled and adds the `watchdog0` alias.

## Why a card

A running watchdog is invisible. The guest prints "Feeding watchdog..." and
some time later the part reboots, with nothing in between to say how close it
came, and afterwards the boot banner looks like any other. The card shows the
stage, its action and the time left while it runs, and keeps the bite after the
reset it caused. On the ESP32-C3 it also shows the SoC's reset-reason register,
which reads `Watchdog (TG0)` afterwards.

## The status block

Every model writes the same 88-byte slot layout, read by `src/hostWatchdog.ts`
on the shared poll beat: enabled, stage, each stage's action and timeout, the
stage deadline and the virtual clock it is measured against, feeds since reset,
and interrupts and bites since the emulator started. Two blocks carry it:

- `qemu_esp_wdt_status()`, from `hw/timer/esp_timg.c` in the ESP32 fork.
- `qemu_browser_wdt_status()`, from `hw/watchdog/browser-wdt-status.c`, which
  `tools/qemu-patches/0014` adds for the CMSDK watchdog and
  `tools/qemu-esp-patches/0017` for the SiFive one.

The page places a devicetree node on a slot by its register address
(`watchdogForAddress()`), since the models number slots in realize order and
know nothing of the devicetree.

Two details are there for the browser. The page reads while QEMU writes, and a
deadline means nothing without its clock, so each slot is a seqlock. And the
page has no guest clock of its own: under `-icount` on TCI guest time runs
slower than the wall's whenever the guest is busy, which is exactly when a
watchdog is about to bite, so while a watchdog runs the model republishes the
virtual clock every 20 ms and the countdown is measured against that.

## What each board needed

**ESP32-C3.** A fix in the fork: the MWDT honoured feeds while locked, and
Zephyr feeds locked from its ISR (on the part that write is dropped), so every
stage 0 interrupt re-armed stage 0 and the sample never reset. See
[esp32.md](esp32.md).

**Cortex-M3.** QEMU has modelled this watchdog all along; the board devicetree
just never declared it. Zephyr's CMSDK driver installs its pre-reset callback
on the NMI, which is where MPS2 wires the block. The LM3S6965 puts it on IRQ 18
instead, and so does QEMU, so the first timeout raises an interrupt nothing
listens to and the second resets the part. The stages are 0.96 s rather than
the sample's 1 s: Zephyr's devicetree says the system clock is 12 MHz and
QEMU's Stellaris model runs it at 12.5 MHz. The card shows what the emulator
does.

**RISC-V.** `virt` has no watchdog, so the patched machine maps QEMU's SiFive E
always-on block at `0x1000d000` (PLIC IRQ 14), whose watchdog is the FE310's
and matches Zephyr's `sifive,wdt` driver register for register. The driver
resets in one stage. Two more fixes were needed before a reset came back up:

- **Every reset of RISC-V `virt` running Zephyr hung**, watchdog or not, and
  on stock QEMU 11.1 too. `pmp_unlock_entries()`, called on CPU reset, clears
  the lock and address-match bits of the first `num_rules` entries rather than
  of every region. Zephyr locks entry 0 over its text and entry 15 as a
  no-execute catch-all, so counting to two left entry 15 locked, and the first
  fetch from the reset vector faulted into a trap vector that faulted too.
  `tools/qemu-esp-patches/0018` unlocks every region and recomputes the cached
  ranges and rule count. Not yet reported upstream; `master` still has it.
- **The second bite never came.** The AON reset cleared only `rsten` and the
  two enable bits, which is all the FE310 manual defines, so `IP0` from the
  first bite stayed pending into the next boot. Zephyr's ISR answers it by
  programming the maximum timeout, over the configuration the sample had just
  installed. The patch clears the whole register at reset, which the manual
  equally allows.

## Not covered

The Cortex-A53 has no watchdog here. QEMU has the SBSA generic watchdog, but
Zephyr has no driver for it. The ESP32-C3's RTC watchdog is not modelled, and
the Xtensa ESP32's timer groups are a separate model that does not publish a
status block.
