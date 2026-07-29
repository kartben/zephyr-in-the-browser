---
tour: Blinky, explained
sample: samples/basic/blinky
---

Zephyr's `samples/basic/blinky` is about twenty lines of C that turn an LED on
and off. Almost none of those lines say anything about the hardware — that is
the whole lesson, and it is the hardest part to see from the source alone.

So this tour reads it out of the machine instead. Each step below breaks
somewhere in the running guest, pulls the relevant bytes out of it, and puts
them next to the code they came from. The sample is stock upstream Zephyr:
nothing was added to it, and nothing needed to be.

## Nothing in this file says which pin

```tour
at: main
show:
  mark: /LED0_NODE/../GPIO_DT_SPEC_GET/
  note: neither of these lines is code — there is nothing here to break on
panel: gpio
watch:
  - controller = **led as string
  - pin = led+1p as u8
  - flags = led+1p+2 as u16
memory:
  at: led
  len: 16
  mark: 0..1p
  note: pointer to the GPIO controller, resolved by the linker
```

The machine is stopped on the first statement of `main()`, and `led` already
holds everything this sample will ever know about the hardware.

`GPIO_DT_SPEC_GET(LED0_NODE, gpios)` expanded **at compile time** into a static
initialiser: a pointer to the controller device, the pin number, and the flags
devicetree gave that pin. Nothing was looked up at runtime and no string was
parsed. Those bytes were in flash before the CPU came out of reset.

That indirection is what lets one source file build for boards with completely
different GPIO hardware. Adding a board is a devicetree change, not a code
change — and the controller's name above is the only part of this that differs
between the three machines this page can boot.

## Drivers were running before `main()` was

```tour
at: main.c:/gpio_pin_configure_dt/ | main.c:32
panel: gpio
registers: pc, sp
watch:
  - device = *led as ptr
  - name = **led as string
  - state = *(*led+3p) as ptr
```

The `gpio_is_ready_dt()` on the line above has already returned true, and it
was never "start the driver". Zephyr initialised its devices during boot, in
dependency order, well before the application got the CPU. The check asks a
much narrower question: does the controller devicetree *declared* have a driver
bound to it, and did that driver's init succeed? A node left `status = "okay"`
for hardware no enabled driver matches reaches exactly that check and fails it.

Look at where the two pointers point. The device itself sits in flash — it is
`const` — while its `state` is a separate object in RAM, because "did this
device initialise" is the one thing about a device that cannot be decided at
build time.

Now the line under the cursor. `gpio_pin_configure_dt()` sets the direction and
the initial level in one call, and `GPIO_OUTPUT_ACTIVE` means output, starting
in its *active* state. Active, not high: if devicetree marked the pin
`GPIO_ACTIVE_LOW`, the driver inverts the level for you and none of this code
changes. Until this call the pin belongs to nobody; configuring it is what
claims it.

## The line that does the work

```tour
at: main.c:/gpio_pin_toggle_dt/ | main.c:38
when: first
panel: led
watch:
  - controller = **led as string
  - pin = led+1p as u8
```

One call, and no register write in sight.

`gpio_pin_toggle_dt()` goes through the GPIO API to whichever driver devicetree
bound to the controller: memory-mapped registers on one board, a VIRTIO request
on another. The sample cannot tell which, and does not need to. Watch the dock
row — the LED that changes is on the far side of that dispatch.

Toggling reads the current level and writes back the opposite, so it too goes
through the active-low flag in the spec. It flips the *logical* level, not the
electrical one.

## `k_msleep()` gives the CPU up

```tour
at: z_impl_k_sleep
when: first
show:
  file: main.c
  mark: /k_msleep/
  note: the call this stop is inside, two layers of inlining down
threads: yes
```

This is not a delay loop. The calling thread comes off the run queue and a
kernel timer is armed to put it back, so the scheduler is free to run other
threads — or to idle the core until the timeout expires.

Notice where this breakpoint is. It is not in the sample at all: it is on
`z_impl_k_sleep`, inside the kernel, which is where `k_msleep()` ends up after
two layers of inlining. The thread list below is the scheduler's own view, and
`main` is about to leave it.

Sleeping may only be done from a thread. Doing it in an interrupt handler is a
kernel error, which is why blinking from an ISR wants a `k_timer` or a work
item instead.

## Once more, ten toggles later

```tour
at: main.c:/gpio_pin_toggle_dt/ | main.c:38
when: hits % 10 == 0
repeat: yes
stop: no
panel: led
watch:
  - stopped in = $pc as code
```

The same line as three steps ago, on every tenth pass, and this time without
stopping the machine: `stop: no` puts the card up and lets the guest run on.

Nothing about that is visible from inside the guest. The breakpoint fires on
every pass, the browser counts the hits, and the nine that do not match are let
go again before the machine has even finished looking stopped — no card, no
register dump, no thread walk. That is the difference between a tour and the
instrumentation it replaces: the sample is not participating, and would build
byte-for-byte the same if this file did not exist.

A blink is once a second, which is a comfortable rate to be counting. A
breakpoint somewhere genuinely hot wants `hits == N` instead, so it fires once
and gets out of the way — see the mutex steps in the philosophers tour.
