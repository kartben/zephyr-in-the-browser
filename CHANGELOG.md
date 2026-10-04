# Changelog

All notable changes to this project are documented here. Also viewable in-app
via the help dialog (?).

## Unreleased

- **Added:** Tours run shell commands, give you tasks, check your work and chain onward.
- **Added:** Tours stop on guest state, show kernel code and open Trace or Debug views.
- **Added:** Tours draw a message queue as a ring, with read and write pointers.
- **Added:** Tours can draw diagrams, like the sensor pipeline map.
- **Added:** Several tours per sample, and links straight to a tour step.
- **Added:** Guided tours get their own gallery section, plus Button, message queue and sensor pipeline tours.
- **Added:** ESP32-C3 DevKitC board with GPIO, I²C, SPI flash, CAN and sleep.
- **Added:** ESP32 DevKitC board (Xtensa), with blinky, button and a shell.
- **Added:** Watchdog sample on ESP32-C3, Cortex-M3 and RISC-V, with a live countdown.
- **Added:** Simulator and Live board modes, with Debug over the desktop bridge.
- **Added:** CPU power states in Trace Timeline and Power tab.
- **Added:** Help button with keyboard shortcuts and this changelog.
- **Added:** More menu on phones for Parts and Samples.
- **Improved:** Emulator switches coroutines with JSPI, not Asyncify: faster guests, half the download.
- **Improved:** Blinky tour shows the Simulator, terminal, and dock first.
- **Improved:** Tours open with their intro; cards show only relevant threads.
- **Improved:** Device dock says I²C/SPI, lists only usable parts, and leaves an edge tab when collapsed.
- **Changed:** Needs Chrome or Edge 137, Firefox 153 or Safari 27 (JSPI).
- **Changed:** Kernel object lists need an image from current Zephyr main.
- **Changed:** Retired the old gateway and probe packages; use the desktop bridge.
- **Fixed:** Resuming from a breakpoint no longer stops on it again.
- **Fixed:** Debug names the right functions and callers, and Cortex-M breakpoints hit.
- **Fixed:** Tour cards keep the stop line in view and name data pointers.
- **Fixed:** Rereading an earlier tour step no longer strands the paused guest.
- **Fixed:** An ELF without a devicetree shows the board's buses.
- **Fixed:** Trace queue depth no longer counts hand-offs to waiting threads.

## [0.5.0] - 2026-07-31

- **Added:** Desktop bridge for real network and Live board tracing.
- **Added:** Settings menu for bridge URL and Bridge network.
- **Added:** Live board home when tracing a physical board.
- **Changed:** Bridge network lives in Settings only.
- **Improved:** Network uplink copy and port-forward recipe.

## [0.4.0] - 2026-07-29

- **Added:** In-browser Bluetooth with Bumble peers you can drive.
- **Added:** Classic A2DP speaker peer with sound on the page.
- **Added:** FAT disk sample with a browser in the dock.
- **Added:** Guided tours that pause the guest and explain it.
- **Added:** Global keyboard shortcuts and ? help dialog.
- **Added:** MCP2515 CAN bus in the device dock.
- **Improved:** Floating panels resize from any edge.

## [0.3.0] - 2026-07-26

- **Added:** Trace panel with timeline, threads, and queues.
- **Added:** Debug with Step, breakpoints, and memory view.
- **Added:** Pause the guest from the page.
- **Added:** Part catalog with datasheet links.
- **Added:** GPIO 7-segment and PT6314 VFD displays.
- **Added:** LP5012 RGB LED and SCT2024 LED bar.
- **Improved:** Flash and EEPROM stats with wear maps.

## [0.2.0] - 2026-07-24

- **Added:** Sensors, GPIO, LEDs, and displays in the device dock.
- **Added:** I²C and SPI bus views with attach/detach and hex dumps.
- **Added:** Ethernet panel with throughput charts and capture.
- **Added:** GNSS, RTC, fuel gauge, DAC, PWM, and stepper rows.
- **Added:** Sample gallery with board and app pickers.
- **Added:** Drop an ELF onto the window to boot a custom image.

## [0.1.0] - 2026-07-22

- **Added:** Initial release. Zephyr running in a browser tab.
- **Added:** Mock backend so the UI runs without an emulator build.
- **Added:** Terminal and board picker to choose what boots.
