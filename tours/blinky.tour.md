---
tour: Blinky: find your way around
sample: samples/basic/blinky
---

Blinky is a short guided sample. These stops introduce the page: the
**Simulator**, the **terminal**, and the **device dock**.

## The terminal is the guest console

```tour
at: main.c:/gpio_pin_configure_dt/ | main.c:32
panel: gpio
```

You are in the **Simulator**. The **terminal** is the guest's serial console.
Boot lines and sample output land here.

Pick the board and app in the top bar to choose what runs.

## Watch the LED in the device dock

```tour
at: main.c:/gpio_pin_toggle_dt/ | main.c:38
when: first
panel: led
```

The **device dock** lists peripherals for this board. Blinky drives an LED:
open that row and watch it toggle as the sample runs.

Other samples show up in other rows (sensors, network, and more).

## Browse samples when you are ready

```tour
at: main.c:/k_msleep/ | main.c:45
when: first
stop: no
panel: led
```

Open the app picker (it currently says **Blinky**) to browse samples. Ones
marked **guided** carry a tour like this one.

Continue to let the guest keep running on its own. The LED keeps blinking.
