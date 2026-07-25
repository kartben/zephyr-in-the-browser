# pwm-leds — LED face on a PWM controller

The guest already packages Zephyr’s stock `pwm-leds` binding against the
browser PCA9685 (`-S pca9685-only`, `samples/drivers/led/pwm`). Until this
work, the page only showed the **PWM controller** card (duty chart). The LED
API was live in the guest, but the dock had nothing that looked like an LED.

This note is the spec for the page-side half: discover `pwm-leds` from the
running build’s flattened tree, and show **both** an LED strip and the
existing PWM panel for that sample.

## Goal

When the running tree has an okay `compatible = "pwm-leds"` node whose
children point at a PWM controller the page models:

1. A dock row under the **LED controllers** class paints those LEDs with
   brightness taken from the provider’s channel duty.
2. The PWM controller row (`PwmBody`) stays as it is — duty chart, channel
   strip, Registers.
3. The packaged **PWM LED** sample expands both on boot
   (`primaryPanels: ['led', 'pwm', 'i2c']`).

No new QEMU device, no new virtio chip, no guest change. The overlay already
declares four `pwm-leds` children on `pca9685_0` channels 0–3.

## Shape (reuse, don’t invent)

Mirror **`gpio-buzzer`**, not a fourth bridge:

| Piece | gpio-buzzer | pwm-leds |
| --- | --- | --- |
| DT compatible | `gpio-buzzer` | `pwm-leds` (+ children) |
| Insights | `GpioController.buzzers` | top-level `pwmLeds[]` |
| Specifier decode | `gpioSpecs` / `#gpio-cells` | `pwmSpecs` / `#pwm-cells` |
| Dock row | own body, `panelKind: 'buzzer'` | own body, `panelKind: 'led'` |
| Live value | GPIO output level | `PwmChip.getChannel(n).duty` |

`led` as `panelKind` is deliberate: HT16K33 and pwm-leds are both LED-facing.
Their bodies differ (`led` matrix vs `pwm-leds` strip). The PWM LED sample has
no HT16K33, so expanding `led` only opens the pwm-leds row.

## Devicetree contract

Child nodes of an okay `pwm-leds` group carry:

```dts
s_led0: s-led-0 {
	pwms = <&pca9685_0 0 PWM_MSEC(20) PWM_POLARITY_NORMAL>;
	label = "PWM LED 0";
};
```

`pwms` is a phandle-array. Cell width comes from the controller’s
`#pwm-cells` (PCA9685: 3 → channel, period ns, flags). Zephyr’s
`PWM_POLARITY_INVERTED` is bit 0 of flags; the LED strip still maps
**brightness = duty** (0…1), because `led_pwm`’s brightness already accounts
for polarity when it programs the pulse — the chart’s duty *is* the LED API
level.

Insights collect one entry per child that resolves a controller the page can
attach (today: any `isPwmChip` on a bridged I²C address). Controllers without
a live chip yield no interactive row (same progressive fill as other bridges).

## Dock inventory

For each okay `pwm-leds` group with at least one resolvable LED against an
attached `PwmChip`:

- `deviceClass: 'led'`
- `body: 'pwm-leds'`
- `panelKind: 'led'`
- `compatible: 'pwm-leds'`
- `chip`: the PWM provider (read-only; LEDs do not poke registers)
- `pwmLeds`: `{ channel, label }[]` in child order
- Path / node name from the group node (`/pwmleds`), like buzzer under `/`

The PCA9685 chip row is unchanged (`deviceClass: 'pwm'`, `body: 'pwm'`,
`panelKind: 'pwm'`).

## UI

`PwmLedsBody` reuses **GpioBody’s LED cell chrome** (bordered secondary tile,
`size-3` primary dot with the same glow when lit, DT `label` underneath). Duty
only scales the dot’s opacity; no extra metrics row. Footer matches the HT16K33 /
PWM cards: one factual line about `pwm-leds`, not invented shell commands
(the packaged sample does not enable `CONFIG_LED_SHELL`).

Mockup rendered from those tokens + `PwmBody`’s real waveform geometry:

[`pwm-leds-mockup.html`](pwm-leds-mockup.html)

No Registers on this card — the PWM controller card already owns the map.

## Out of scope

- `pwm-buzzer` (pitch) — still the separate follow-up in next-drivers.md
- Non-I²C PWM providers — `PwmChip` already allows them; attach when one exists
- Folding LEDs into `PwmBody` — rejected so the LED class stays discoverable
  and both rows can expand independently
- Guest overlay / Kconfig changes — already correct

## Acceptance

- Insights tests discover the four LEDs from a PCA9685 + `pwm-leds` fixture
- Topology emits an interactive `pwm-leds` row with `panelKind: 'led'` alongside
  the PWM chip row
- Sample gallery / boot: PWM LED opens LED strip + PWM chart + I²C
- `npm test` and `npm run typecheck` clean
