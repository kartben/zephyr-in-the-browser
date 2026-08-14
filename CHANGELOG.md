# Changelog

All notable changes to this project are documented here. Also viewable in-app
via the help dialog (?).

## Unreleased

- **Added:** Button tour for gpio-keys and input events.
- **Improved:** Blinky tour shows the LED pin from devicetree.
- **Added:** Help button in the top bar for shortcuts and changelog.
- **Improved:** Collapsed device dock leaves an edge tab to reopen it.
- **Added:** In-app changelog tab in the keyboard help dialog.
- **Added:** Open Settings shortcut (Ctrl+, / ⌘,).
- **Added:** Live board attach card in the Debug panel.
- **Added:** Mode switch between Simulator and Live board.
- **Added:** CPU power states in Trace Timeline and Power tab.
- **Improved:** Live board Debug over the desktop bridge.

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
