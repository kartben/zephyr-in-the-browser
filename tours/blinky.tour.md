---
tour: Blinky: LED, GPIO, sleep
sample: samples/basic/blinky
---

This is Zephyr’s blinky sample: configure an LED pin, toggle it in a loop, and
sleep between toggles.

Watch the LED in the **device dock** while you step. The stops show how the
sample finds that pin in **devicetree**, calls the GPIO **API**, and yields with
`k_msleep()` so the **kernel** can schedule other work.

## Nothing here says which pin

```tour
at: main.c:/gpio_pin_configure_dt/ | main.c:32
highlight: /GPIO_DT_SPEC_GET/
panel: gpio
```

**Devicetree** describes the board’s hardware. `GPIO_DT_SPEC_GET` looks up the
`led0` alias at **build** time and fills a `gpio_dt_spec` (controller, pin, and
flags), so this file never hard-codes a pin number.

That lookup already happened before `main` ran. Change boards by changing
devicetree (or the board picker), not by editing this sample’s pin math.

## What devicetree chose, arriving at the driver

```tour
at: gpio_virtio_pin_configure | qhg_pin_configure
panel: gpio
watch:
  - controller = *$arg0 as string
  - pin = $arg1 as dec
  - flags = $arg2 as dec
memory:
  at: $arg0
  len: 32
  mark: 2p..3p
  note: GPIO driver entry for this controller
```

`gpio_pin_configure_dt()` takes that `gpio_dt_spec` and asks the GPIO **driver**
bound to the controller to set the pin up.

Check the GPIO / LED rows in the **device dock**: the pin is an output.
`GPIO_OUTPUT_ACTIVE` means “start in the active state,” which is not the same
as logic high. If the pin is `GPIO_ACTIVE_LOW` in devicetree, active means
driven low. The sample code stays the same either way.

## One call, and no register write in sight

```tour
at: main.c:/gpio_pin_toggle_dt/ | main.c:38
when: first
panel: led
```

The loop body is `gpio_pin_toggle_dt()`. The GPIO API flips the pin’s logical
level and handles active-low for you.

Watch the LED in the **device dock** (and the `LED state:` lines in the
**terminal**). You do not need to know how this board wires GPIO underneath.
The sample only talks to the API.

## `k_msleep()` gives the CPU up

```tour
at: z_impl_k_sleep
when: first
threads: yes
```

This is not a busy-wait. `k_msleep()` asks the **kernel** to wake this **thread**
later, takes it off the run queue, and arms a timer so another thread can run,
or the **idle** thread can run until the timeout.

Open the thread list in **Debug** on this stop (`main` is blinky; it is about to
leave the ready set). Sleeping is only legal from a thread; from an **interrupt
handler** (ISR) you would use a `k_timer` or work item instead.

## Every write is a mask of pins

```tour
at: gpio_virtio_port_toggle_bits | qhg_port_toggle_bits
when: hits % 10 == 0
repeat: yes
stop: no
panel: led
```

Ten blinks later, deeper in the stack, a single-pin toggle becomes a **bitmask**
on the port: `16` is `BIT(4)`, pin 4 and nothing else.

Prefer watching the LED again over reading the mask. If you want the public API
for flipping several pins at once, that is `gpio_port_toggle_bits()`.
