---
tour: Blinky, explained
sample: samples/basic/blinky
---

Twenty lines of C that turn an LED on and off, and almost none of them say
anything about the hardware. That is the lesson, and it is the part you cannot
see from the source — so this tour stops the running machine and reads the
missing half out of it.

## Nothing here says which pin

```tour
at: main.c:/gpio_pin_configure_dt/ | main.c:32
highlight: /GPIO_DT_SPEC_GET/
panel: gpio
registers: pc, sp
```

`GPIO_DT_SPEC_GET` (highlighted, twenty lines above the stop) expanded **at
compile time** into three constants: a pointer to the controller, a pin, and
that pin's flags. Nothing is looked up at runtime and no string is parsed.

Which is why the pin is nowhere in this file. Adding a board is a devicetree
change, not a code change.

## The numbers devicetree chose, arriving at the driver

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
  note: api — the driver's function table, which is the whole dispatch
```

Same call, one layer down, in a driver the sample never names. The pin the
source would not tell you is right there in the second argument register.

`GPIO_OUTPUT_ACTIVE` means output, starting *active* — not high. If devicetree
marked the pin `GPIO_ACTIVE_LOW` the driver inverts it, and no code changes.

## One call, no register write

```tour
at: main.c:/gpio_pin_toggle_dt/ | main.c:38
when: first
panel: led
```

The whole loop body. `gpio_pin_toggle_dt()` reaches whichever driver devicetree
bound to the controller — memory-mapped registers on one board, a VIRTIO
request on another — and the sample cannot tell which.

Watch the dock row: the LED that changes is on the far side of that dispatch.

## `k_msleep()` gives the CPU up

```tour
at: z_impl_k_sleep
when: first
threads: yes
```

Not a delay loop. The thread leaves the run queue and a kernel timer puts it
back, so the scheduler is free to run something else — or to idle the core.

Note where this breakpoint is: not in the sample at all, but inside the kernel,
where `k_msleep()` ends up after two layers of inlining.

## Once more, ten toggles later

```tour
at: gpio_virtio_port_toggle_bits | qhg_port_toggle_bits
when: hits % 10 == 0
repeat: yes
stop: no
panel: led
watch:
  - pins = $arg1 as dec
  - stopped in = $pc as code
```

Every tenth blink, and this time without stopping the machine — `stop: no` puts
the card up and lets the guest run on.

The breakpoint traps on every pass; the browser counts them and lets the nine
that do not match go again, before the machine has finished looking stopped. The
sample is not participating in any of it, and would build byte-for-byte the same
if this file did not exist.
