---
tour: Blinky: LED, GPIO, sleep
sample: samples/basic/blinky
---

This is Zephyr's blinky sample. It finds an LED in **devicetree**, configures
the pin, then toggles it in a loop.

Watch the LED in the **device dock** while you step.

## The pin comes from the board

```tour
at: main.c:/gpio_pin_configure_dt/ | main.c:32
highlight: /GPIO_DT_SPEC_GET/
dts: /led0: led_0/ + 3
panel: gpio
```

An application typically does not reference pin numbers directly. The board's
**devicetree** names the LED `led0`, and `GPIO_DT_SPEC_GET` looks that alias up
at **build** time.

`gpio_pin_configure_dt()` then sets that pin as an output. Check the GPIO row
in the **device dock**: the pin is an output.

## Toggle the LED

```tour
at: main.c:/gpio_pin_toggle_dt/ | main.c:38
when: first
panel: led
```

The loop calls `gpio_pin_toggle_dt()`. The GPIO **API** flips the pin for you.

Watch the LED in the **device dock**, and the `LED state:` lines in the
**terminal**.

## Sleep between blinks

```tour
at: main.c:/k_msleep/ | main.c:45
when: first
stop: no
panel: led
```

`k_msleep(SLEEP_TIME_MS)` asks the **kernel** to wake this **thread** in one
second. The LED stays on (or off) long enough to see.

Without this call, the pin would toggle as fast as the CPU can go.
