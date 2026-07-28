# Bluetooth: Zephyr host + Bumble controller

The guest runs Zephyr's Bluetooth **host** over H:4 (`zephyr,bt-hci-uart`).
The page runs a [Bumble](https://google.github.io/bumble/) **virtual
controller** under Pyodide and speaks HCI on the `hci0` browser chardev.
The air between peers is a Bumble `LocalLink` — the same "page is the medium"
shape as Ethernet and CAN.

Feasibility and role split:
[`bluetooth-bumble-feasibility.md`](bluetooth-bumble-feasibility.md).
Per-peer configure/control UI (draft):
[`bluetooth-peer-ui-spec.md`](bluetooth-peer-ui-spec.md).

## Layout

| Piece | Where |
| --- | --- |
| QEMU `hci0` chardev slot | `tools/qemu-*-patches/*chardev-add-browser-hci-slot.patch` |
| A53 HCI UART @ `0x090f0000` | `tools/qemu-jit-patches/0019-hw-char-add-browser-hci-uart-on-virt.patch` |
| RISC-V HCI UART @ `0x1000c000` | `tools/qemu-riscv-patches/0014-hw-char-add-browser-hci-uart-on-RISC-V-virt.patch` |
| Feature bit `"hci"` | `tools/build-qemu-wasm.sh` → `features.json` |
| Page bridge | `src/hostBt.ts`, `src/bt/h4.ts`, `src/bt/bumbleController.ts` |
| In-page peers | `src/bt/peers.ts` — HRM / advertiser / scanner on the same LocalLink |
| Bumble wheel | `public/vendor/bumble/` — see its README; fetch with `tools/vendor-bumble.sh` |
| Guest snippet / conf | `zephyr-module/snippets/bt-hci-uart/`, `zephyr-module/conf/bt-hci.conf` |
| Persistent settings | `bt-settings-spi` W25Q80 on CS1 + `storage_partition` → Zephyr NVS |
| Packaged sample | `bt_peripheral` → `samples/bluetooth/peripheral` |

## Rebuild checklist

1. **Emulator** (once): `tools/build-qemu-wasm.sh` so `features.json` lists `"hci"`.
2. **Wheel** (once / on bump): `tools/vendor-bumble.sh`.
3. **Guest image**: `tools/build-zephyr-image.sh qemu_cortex_a53 bt_peripheral`
   (or rebuild all A53 images).

Without step 1 the page never passes `-chardev browser,id=hci0` (older
emulators exit on an unknown backend). Without step 2 the dock shows the HCI
pipe but controller start fails on a missing wheel.

## First demo

1. Select **QEMU Cortex-A53** → **BLE peripheral**.
2. Wait for the Bluetooth dock row: phase should move to **Controller ready**.
3. Guest advertises; HCI packet counters in the dock should climb.
4. Under **On the air**, use **Add peer** for a Scanner (sees adv reports),
   Heart rate monitor, or plain Advertiser — all on the in-tab LocalLink.
   No server; same shape as Ethernet/CAN peers in the page.

The packaged Bluetooth images also compose the `bt-settings-spi` snippet.
Zephyr's NVS settings backend stores the generated identity, IRK, and GATT
database hash in its `storage_partition`; the simulated W25Q on CS1 persists
those sectors in browser storage across reloads. It is a separate physical
model and persistence key from the general SPI flash / LittleFS chip on CS0, so
switching samples cannot make NVS and LittleFS overwrite each other's formats.

External Hive over WebSocket (or a real dongle) remains an optional follow-up
once someone wants peers outside this tab.
