# Changelog

All notable changes to this project are documented here. Also viewable in-app
via the help dialog (?).

## Unreleased

- **Added:** In-app changelog tab in the keyboard help dialog.
- **Added:** One-shot semver release workflow for cutting app tags.
- **Added:** Live board GDB attach card in the Debug panel.
- **Added:** Session mode switch between Sim and Live board.
- **Added:** CPU power states in Trace Timeline and Power tab.
- **Improved:** Desktop bridge routes GDB frames to the owning client.

## [0.5.0] - 2026-07-30

- **Added:** Desktop bridge for real network and Live board tracing.
- **Added:** Settings menu for bridge URL and network uplink.
- **Added:** Live board home surface when tracing a physical board.
- **Added:** Probe daemon for serial CTF into Trace.
- **Changed:** Bridge network is Settings-only (no separate gateway UI).
- **Improved:** Network uplink copy and port-forward recipe.

## [0.4.0] - 2026-07-28

- **Added:** In-browser Bluetooth with Bumble HCI and controllable peers.
- **Added:** Classic A2DP speaker peer with SBC decode.
- **Added:** Virtio-blk FAT disk with a dock browser.
- **Added:** Guided tours driven by the debugger, shipped with the page.
- **Added:** Global keyboard shortcuts and ? help dialog.
- **Added:** MCP2515 CAN on virtio-SPI.
- **Improved:** Floating panels resize from any edge.

## [0.3.0] - 2026-07-26

- **Added:** Trace panel with timeline, threads, and queues.
- **Added:** GDB stub path with Step, breakpoints, and memory UI.
- **Added:** Browser-backed QEMU monitor to pause the guest.
- **Added:** Part identity catalog with datasheet links.
- **Added:** GPIO 7-segment and PT6314 VFD aux displays.
- **Added:** LP5012 RGB LED and SCT2024 SPI LED bar.
- **Improved:** Flash and EEPROM stats with wear maps.

## [0.2.0] - 2026-07-24

- **Added:** Device dock with sensors, GPIO, LEDs, and displays.
- **Added:** I²C and SPI bus views with attach/detach and hex dumps.
- **Added:** Ethernet panel with throughput charts and capture.
- **Added:** GNSS, RTC, fuel gauge, DAC, PWM, and stepper rows.
- **Added:** Sample gallery with board and app pickers.
- **Added:** Drop an ELF onto the window to boot a custom image.

## [0.1.0] - 2026-07-22

- **Added:** Initial release. Zephyr in a browser tab via qemu-wasm.
- **Added:** Mock backend so the UI runs without an emulator build.
- **Added:** Terminal chrome, board picker, and GitHub Pages deploy.
