# Changelog

All notable changes to this project are documented here. Also viewable in-app
via the help dialog (?).

## Unreleased

- **Added:** Hover a variable in tour code to see its value.
- **Added:** Tours run shell commands, give you tasks, check your work and chain onward.
- **Added:** Tours stop on guest state, show kernel code and open Trace or Debug views.
- **Added:** Tours draw a message queue as a ring, with read and write pointers.
- **Added:** Tours can draw diagrams, like the sensor pipeline map.
- **Added:** Several tours per sample, and links straight to a tour step.
- **Added:** Guided tours get their own gallery section, plus Button, message queue, sensor pipeline, zbus and state machine tours.
- **Added:** Message Queue Lab sample and tour, driven from the shell.
- **Added:** zbus tab in Trace, and CPU sleep states in the Power tab.
- **Added:** Trace IPC shows mutexes, semaphores and condvars, and who holds them.
- **Added:** ESP32-C3 DevKitC board with GPIO, I²C, SPI flash, CAN and sleep.
- **Added:** ESP32 DevKitC board (Xtensa), with blinky, button and a shell.
- **Added:** Watchdog sample on ESP32-C3, Cortex-M3 and RISC-V, with a live countdown.
- **Added:** Magic Wand TinyML sample on Cortex-A53, with replayable gestures and a capture page.
- **Added:** Simulator and Live board modes, with Debug over the desktop bridge.
- **Added:** Help button with keyboard shortcuts and this changelog.
- **Added:** More menu on phones for Parts and Samples.
- **Improved:** Emulator switches coroutines with JSPI, not Asyncify: faster guests, half the download.
- **Improved:** Larger, higher-contrast tour text in both themes.
- **Improved:** Blinky tours: a page tour that chains on, and one through the code.
- **Improved:** Tours open on an intro card listing their stops.
- **Improved:** Tour cards move, resize and show only relevant threads.
- **Improved:** Device dock opens folded to the sample's devices, says I²C/SPI, lists only usable parts, and leaves an edge tab when collapsed.
- **Improved:** Trace Timeline shows thread priorities and what blocked threads wait on.
- **Improved:** Tour cards sit beside the dock, full height, and outline what they name.
- **Changed:** Trace's Queues tab is now IPC, with graph filters.
- **Changed:** Needs Chrome or Edge 137, Firefox 153 or Safari 27 (JSPI).
- **Changed:** Kernel object lists need an image from current Zephyr main.
- **Changed:** Retired the old gateway and probe packages; use the desktop bridge.
- **Fixed:** Resuming from a breakpoint no longer stops on it again.
- **Fixed:** Debug names the right functions and callers, even at a function's start, and Cortex-M breakpoints hit.
- **Fixed:** Debug register tooltips name the current function's arguments.
- **Fixed:** Tour cards keep the stop line in view and name data pointers.
- **Fixed:** Rereading an earlier tour step no longer strands the paused guest.
- **Fixed:** A tour card's X minimises it instead of skipping the stop.
- **Fixed:** An ELF without a devicetree shows the board's buses.
- **Fixed:** Trace queue depth no longer counts hand-offs to waiting threads.
- **Fixed:** Trace Timeline no longer marks a thread blocked for waking another.
- **Fixed:** The guest reads the ADXL345 at its real scale, not four times too high.
- **Fixed:** Cortex-A53 samples boot without an "xlat tables low" warning.
- **Fixed:** Trace's IPC graph keeps your zoom as new routes appear.
- **Fixed:** Trace charts are readable in light mode.
- **Fixed:** Thread and object lists no longer pass the last stop off as current.

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
