---
tour: Blinky, explained
sample: samples/basic/blinky
---

Twenty lines of C that turn an LED on and off — and almost none of them say
anything about the hardware. That is the point of this sample, and it is the
part you cannot see by reading it. So here is where each missing piece comes
from, on the board you are running.

## Nothing here says which pin

```tour
at: main.c:/gpio_pin_configure_dt/ | main.c:32
highlight: /GPIO_DT_SPEC_GET/
panel: gpio
```

The highlighted line is the only place this sample learns about hardware, and
it has already run. `GPIO_DT_SPEC_GET` is a devicetree macro: it looks up the
`led0` alias **while the code is compiling** and expands into three constants —
which GPIO controller, which pin on it, and how that pin is wired.

So there is no pin number in this file, and nothing is looked up while the
program runs. Porting blinky to a new board is a devicetree change, not a code
change.

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
  note: the driver's function table for this controller
```

The same call, one layer down. `gpio_pin_configure_dt()` is a thin inline
wrapper over the GPIO API, and the API hands the work to whichever driver is
bound to that controller — here it is, with the values devicetree picked.

`GPIO_OUTPUT_ACTIVE` means an output that starts in its *active* state, which is
not the same as high. If devicetree marked the pin `GPIO_ACTIVE_LOW`, the driver
drives it low to make it active, and nothing in the sample changes.

Every device in Zephyr carries a pointer to its driver's function table, marked
above. That indirection is what lets one call reach seven different GPIO
drivers.

## One call, and no register write in sight

```tour
at: main.c:/gpio_pin_toggle_dt/ | main.c:38
when: first
panel: led
```

The whole loop body. `gpio_pin_toggle_dt()` reads the pin's current level and
writes back the opposite — through the same API, so the inversion for an
active-low pin is handled for you.

Underneath, that reaches memory-mapped registers on one board and a VIRTIO
request to a device on another. The sample cannot tell which, and does not need
to. Watch the LED: it is on the far side of that dispatch.

## `k_msleep()` gives the CPU up

```tour
at: z_impl_k_sleep
when: first
threads: yes
```

This is not a delay loop. The thread asks the kernel to be woken in a
millisecond's time, and the kernel takes it off the run queue and arms a timer —
so the CPU is free to run another thread, or to idle until the timeout expires.

Below is every thread alive right now. `main` is the one running blinky, and it
is about to leave the list; `idle` is what the kernel runs when nothing else is
ready.

Sleeping is only allowed from a thread. Doing it in an interrupt handler is a
kernel error, which is why blinking from an ISR wants a `k_timer` or a work item
instead.

## Every write is a mask of pins

```tour
at: gpio_virtio_port_toggle_bits | qhg_port_toggle_bits
when: hits % 10 == 0
repeat: yes
stop: no
panel: led
watch:
  - pins = $arg1 as dec
  - in = $pc as code
```

Ten blinks later, at the bottom of the stack. Whatever the API is asked to do to
*one* pin arrives at the driver as an operation on a **mask** of pins: `16` is
`BIT(4)`, pin 4 and nothing else.

That is why a driver only has to implement a handful of port-level operations —
set, clear, toggle, read — and gets per-pin calls, active-low handling and
devicetree specs for free from the layers above. It also means you can flip
several pins in one bus transaction when you want to, with
`gpio_port_toggle_bits()`.
