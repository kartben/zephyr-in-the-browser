---
tour: Button: keys, input, callback
sample: samples/basic/button
---

This is Zephyr's button sample. It waits for a key event, then prints and
lights an LED.

Watch **GPIO Keys** in the **device dock**. You will press **SW0** after the
sample starts waiting.

## The button comes from the board

```tour
at: main.c:/Press the button/ | main.c:40
dts: /button0: button_0/ + 4
panel: keys
```

An application typically does not reference pin numbers directly. The board's
**devicetree** describes SW0 as a `gpio-keys` node.

The **input** subsystem turns a press into a key event. This sample never looks
up the pin.

## Main waits

```tour
at: main.c:/k_sleep/ | main.c:42
highlight: /INPUT_CALLBACK_DEFINE/
panel: keys
```

`main` calls `k_sleep(K_FOREVER)`, so this **thread** sleeps and does not
return.

`INPUT_CALLBACK_DEFINE` registered `button_input_cb` at **build** time. The
**input** subsystem calls it when a key event arrives.

Continue, then press **SW0** in **GPIO Keys**.

## A press is an input event

```tour
at: button_input_cb | main.c:/static void button_input_cb/ | main.c:20
when: first
highlight: /static void button_input_cb/ + 14
panel: led
```

You are in `button_input_cb`. `evt->value` tells you pressed or released.

`led_set_brightness_dt()` sets the LED. Continue so the callback can finish,
then watch the LED in the **device dock** and the `Button` lines in the
**terminal**.
