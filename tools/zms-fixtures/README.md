# ZMS fixtures

A Zephyr app that writes the ZMS images `src/lib/zmsBrowse.test.ts` reads, with
Zephyr's own ZMS and settings code on `qemu_x86`'s simulated flash, then prints
each partition as hex. Regenerate after a ZMS format change:

```sh
west build -p always -b qemu_x86 -d build/zms tools/zms-fixtures
qemu-system-i386 -m 32 -cpu qemu32,+nx,+pae -machine q35 -no-reboot -nographic \
  -net none -kernel build/zms/zephyr/zephyr.elf > zms.out   # Ctrl-A X once "ZMSDUMP done"
node tools/zms-fixtures/dump.mjs zms.out src/lib/fixtures/zms
```

Variants, same commands with extra CMake arguments:

- `-- -DEXTRA_CONF_FILE=id64.conf` writes `zms-id64-raw.bin` (64-bit ids).
- `-- -DEXTRA_CONF_FILE=busy.conf -DEXTRA_DTC_OVERLAY_FILE=busy.overlay` writes
  a 64 KiB settings store in Kite Rush's geometry, wrapped round a few times. It
  is a demo image, not a fixture: seed it into the page as
  `localStorage['zephyr.w25q.2']` (`{v: 1, size: 1048576, sectorSize: 4096,
  sectors: {index: hex}}`) to open the ZMS view on a busy store.
