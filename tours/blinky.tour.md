---
tour: "Blinky: find your way around"
sample: samples/basic/blinky
source: no
next: basic_button
---

Blinky blinks an LED once a second, forever. These stops show you around the
page while it runs: the **terminal**, the **device dock**, **Debug**, and
where to pick another sample.

## The terminal is the guest console

```tour
at: main.c:/gpio_pin_configure_dt/
when: first
stop: no
```

You are in the **Simulator**: Zephyr runs on an emulated board, right in your
browser. The **terminal** is the guest's serial console. Boot messages and the
sample's output land there.

The board and the app in the top bar choose what runs.

## Watch the LED in the device dock

```tour
at: main.c:/gpio_pin_toggle_dt/
when: first
panel: led
```

The guest is paused just before Blinky flips its LED.

The **device dock** lists this board's peripherals, and the LED has a row of
its own. Press **Continue** and watch it change.

## Debug shows where the guest is

```tour
at: main.c:/k_msleep/
when: first
look: debug.threads
```

Every stop in a tour is a breakpoint. **Debug**, under Instruments in the
device dock, shows where the guest is paused: the call stack, the CPU
registers, memory, and the threads.

Blinky's code runs in one thread, `main`. It is about to sleep for a second,
and `idle` runs while it does.

## Browse samples when you are ready

```tour
at: main.c:/gpio_pin_toggle_dt/
when: first
stop: no
```

Open the app picker in the top bar, which says **Blinky** now, to try another
sample. The ones with a tour like this one are listed first, under
**Guided tours**.

## What you saw

That is the page: the terminal for output, the device dock for peripherals,
and Debug for the guest's state. Blinky keeps blinking.

Blinky has a second tour, **Blinky, explained**, listed under Blinky in the
app picker. It follows the LED's pin from devicetree into the GPIO driver.

Or go on to the Button sample, which reads a key you press in the device
dock.
