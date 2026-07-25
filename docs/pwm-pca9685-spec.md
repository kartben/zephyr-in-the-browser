# Spec: PWM dock class + PCA9685

Next I²C peripheral after HT16K33. Opens a new dock class (**PWM**)
with an oscilloscope-style duty-cycle chart as the hero of the card.

## Dock card mockup

<img alt="PCA9685 PWM dock card mockup" src="mockups/pwm-pca9685-dock-card.png" width="420" />

Hero is the **time-domain square wave** for the selected channel: slightly
more than one period (~1.25×), with period / high / low callouts, duty +
frequency chip, a 16-channel duty strip, and the usual Registers affordance.

## Goals

| | |
| --- | --- |
| Chip | NXP PCA9685 — `nxp,pca9685-pwm` |
| Address | **0x60** (see note) |
| Sample | `samples/drivers/led/pwm` (PWM-backed `pwm-leds`) |
| Dock class | new **`pwm`** / “PWM” |
| Map | MODE1/MODE2, LEDn_ON/OFF×16, PRE_SCALE — JSON under `chips/maps/` |
| Viz | Duty-cycle chart (below) — not another LED matrix |
| v1 | Output only; no OE pin, no external CLK, no ALLCALL |

**Address note.** Adafruit’s shield defaults to `0x40`, which is already
`ina219@40` in our virtio-i2c catalog. Two children with the same `reg` is
a mess even when one is disabled. Use **0x60** (A0–A5 strap / solder-bridge
story) so both parts can stay declared. Document the delta from Adafruit
in the overlay comment.

## Why this, not LP5562

LP5562 would reuse the LED class we just shipped. PCA9685 opens **PWM** —
a new Zephyr API surface (`pwm_set` / `led_pwm`) and a visualization that
doesn’t exist elsewhere in the dock (GPIO LEDs are on/off dots; HT16K33 is
a matrix of bits). Same cheap track: I²C register file, stock driver, no
QEMU rebuild.

## Chip model

### Hardware facts (driver-aligned)

From Zephyr `drivers/pwm/pwm_pca9685.c` and the datasheet:

| | |
| --- | --- |
| Channels | 16 |
| Resolution | 12-bit (4096 steps) |
| Internal OSC | 25 MHz |
| Output rate | ≈ 24 Hz … 1526 Hz via `PRE_SCALE` |
| Default PRE_SCALE | `0x1E` → ~200 Hz |
| Per channel | `LEDn_ON_L/H`, `LEDn_OFF_L/H` (ON count usually 0; OFF = duty) |
| Full on / off | bit 4 of ON_H / OFF_H |
| Shared period | one PRE_SCALE for all channels |

Period in wall time:

\[
f_{\mathrm{PWM}} = \frac{25\,\mathrm{MHz}}{4096 \times (\mathrm{PRE\_SCALE}+1)}
\qquad
T = 1 / f_{\mathrm{PWM}}
\]

Duty (when not full-on/off):

\[
\mathrm{duty} = \frac{\mathrm{OFF} - \mathrm{ON}}{4096}
\quad\text{(driver writes ON=0, OFF=\mathrm{round}(\mathrm{pulse}/\mathrm{period}\times 4096))}
\]

### TypeScript surface

```ts
interface Pca9685Chip extends I2cChip {
  readonly channels: 16
  readonly registers: readonly RegisterDecl[]
  peek / poke / setField / subscribe / version  // RegisterMapSource

  getPreScale(): number
  getFrequencyHz(): number
  getPeriodNs(): number

  /** Per-channel decoded view for the chart + strip. */
  getChannel(n: number): {
    on: number        // 0..4095 (+ full-on flag)
    off: number
    fullOn: boolean
    fullOff: boolean
    duty: number      // 0..1
    pulseNs: number
    inverted: boolean // last flags from pwm_set, if tracked
  }
}
```

I²C: pointered register file (MODE1 sets `AI`). Match the driver’s write
patterns — `set_cycles` blasts 5 bytes starting at `LEDn_ON_L`; PRE_SCALE
updates go through SLEEP → write → wake → RESTART.

### JSON register map (`chips/maps/pca9685.json`)

Minimum viable named rows:

- `MODE1` (0x00) — RESTART, AI, SLEEP, …
- `MODE2` (0x01) — OUTDRV, OCH, …
- `LED0_ON_L` … `LED15_OFF_H` (0x06–0x45) — can be one row-per-register
  or a condensed “LED0”…”LED15” with 32-bit ON/OFF fields; prefer **explicit
  byte registers** so poke matches the bus
- `PRE_SCALE` (0xFE)

Skip ALL_LED_* and SUBADR* in v1 (driver doesn’t touch them).

## Dock UX — the chart

### Hierarchy (one job)

1. **Waveform** (hero) — selected channel’s square wave, ~1.25 periods
2. **Channel strip** — 16 mini duty bars; click selects the hero channel
3. **Metrics** — ON/OFF counts, PRE_SCALE, drive mode
4. **Registers** — shared SVD dialog

No servo angle knobs, no RGB color picker, no second chart. Guest drives
the outputs; the card *reads* them.

### Waveform anatomy (must show)

| Annotation | Meaning |
| --- | --- |
| Trace | HIGH plateau then LOW; second rising edge so period isn’t ambiguous |
| `T = …` | Full period double-arrow (ms or µs, auto-scale) |
| `t_high = …` | Pulse width bracket |
| `t_low = …` | Remainder bracket (`T − t_high`) |
| `N% duty · F Hz` | Corner chip (derived) |
| `HIGH` / `LOW` | Phase labels |
| Falling-edge guide | Vertical dashed line at end of pulse |
| X ticks | `0`, `T/2`, `T`, `1.25T` |

**Full-on / full-off:** flat HIGH or flat LOW across the plot, with a
badge `full-on` / `full-off` instead of duty math (OFF/ON flags, not a
real pulse).

**Polarity inverted:** draw the electrical output the guest asked for
(driver inverts pulse before programming counts). Label `inv` in the
metrics strip when set.

### Channel strip

- 16 equal columns, fill height = duty (full-on = 100%, full-off = 0%)
- Selected channel: primary outline + crumb `CH{n}`
- Collapsed dock badge: `CH{n} · {duty}%` or `16 ch · {f} Hz`

### Motion (2–3 intentional)

1. Waveform redraws on channel register / PRE_SCALE change (rAF coalesce)
2. Soft highlight pulse on the strip cell that just changed
3. Optional: a phase cursor sweeping at `f` when the panel is expanded
   and `document.visibilityState === 'visible'` — **nice-to-have**, not
   required for v1; static annotated period is the teaching tool

## Topology / packaging

| Piece | Value |
| --- | --- |
| `DeviceClass` / `BodyKind` / `PanelKind` | `'pwm'` |
| `ChipKind` | `'pwm'` |
| `CLASS_LABELS.pwm` | `'PWM'` |
| Compat | `nxp,pca9685-pwm` → insights panel `pwm` |
| Registry | `id: 'pca9685'`, defaultAddress `0x60` |
| Overlay | `pca9685_0: pca9685@60` disabled by default |
| Snippet | `pca9685-only` — enable chip + `pwm-leds` children; disable default sensors/OLED/EEPROM/LCD/HT16K33 |
| Conf | `conf/pca9685.conf` — `CONFIG_I2C`, `CONFIG_PWM`, `CONFIG_PWM_PCA9685`, `CONFIG_LED`, `CONFIG_LED_PWM`, stack bump |
| Sample id | `pwm_led` → `samples/drivers/led/pwm` |
| Boards | A53 + riscv32 (same as other I²C class samples) |

### Devicetree shape (snippet)

```dts
&pca9685_0 {
	status = "okay";
};

/ {
	pwmleds {
		compatible = "pwm-leds";
		/* Start with 4 channels — enough for the stock sample loop;
		 * chip still models all 16 in the page. */
		s_led0: s-led-0 {
			pwms = <&pca9685_0 0 PWM_MSEC(20) PWM_POLARITY_NORMAL>;
			label = "PWM LED 0";
		};
		/* … s-led-1 .. s-led-3 … */
	};
};
```

Stock sample binds `DT_COMPAT_GET_ANY_STATUS_OKAY(pwm_leds)` and walks
`led_on` / `led_set_brightness` / `led_blink` — same path as the Adafruit
shield doc (`--shield adafruit_pca9685`), just our address and bus.

## Out of scope (v1)

- Keyscan-style inputs, OE GPIO, external oscillator
- Servo-angle overlay (° ↔ pulse µs) — fine as a later mode toggle
- Declaring all 16 `pwm-leds` (four is enough for the sample; strip still shows 16 from the chip)
- Moving INA219 off 0x40 / using Adafruit’s 0x40

## Acceptance

- [ ] Guest `samples/drivers/led/pwm` fades / blinks; chart duty and `t_high` track
- [ ] Changing PRE_SCALE (via brightness periods / driver) updates `T` and Hz
- [ ] Channel strip selection switches the hero wave without detaching
- [ ] Registers dialog edits LED counts and the chart follows
- [ ] Detach → guest LED API errors; reattach recovers
- [ ] `npm test` / `tsc` green; manifest ↔ boards lockstep

## Implementation sketch

1. `chips/pca9685.ts` + `maps/pca9685.json` + unit tests (PRE_SCALE math, set_cycles byte patterns)
2. `PwmPanel.tsx` — canvas waveform + strip (mirror `LedPanel` structure)
3. Topology / registry / insights / gallery wiring (`pwm`)
4. Overlay, `pca9685-only`, conf, manifest, docs
5. Preview route optional (`?preview=pwm`) for screenshot parity with `?preview=regmap`
