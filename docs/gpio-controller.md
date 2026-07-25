# GPIO dock — Proposal B (detailed spec)

Confirmed direction from the mockup review: **claimed-pins-only** controller
table, with **`used by` → jump to the consumer widget** (reveal + blink).
This note is the build contract. No implementation until you sign off.

Source mockup: [`gpio-controller-mockup.html`](gpio-controller-mockup.html)
(Proposal B block). Related: the LED split in [`pwm-leds.md`](pwm-leds.md).

---

## 1. Goal

For bridged GPIO controllers the page understands (`qemu,host-gpio`,
`virtio,gpio`):

1. **`gpio-keys`** leave the GPIO card → own dock row (Keys class), same move
   as `gpio-leds` / `gpio-buzzer`.
2. **`gpio-leds`** stay as today’s LED-class row (`GpioLedsBody`).
3. **`gpio-buzzer`** stays its own Buzzer row.
4. The **GPIO controller** card becomes a compact **claimed-pin table**: only
   pins that have a DT consumer *or* a live runtime direction. Idle unused
   pins stay invisible.
5. Clicking **`used by`** reveals the matching consumer row (unhide, expand
   class group, expand row, scroll into view) and plays a short **attention
   blink** on that row.

---

## 2. Dock inventory

### 2.1 New / changed rows

| Row key | `compatible` | `deviceClass` | `body` | `panelKind` |
| --- | --- | --- | --- | --- |
| `gpio-keys` | `gpio-keys` | `keys` (new) | `gpio-keys` | `keys` (new `PanelKind`) |
| `gpio-leds` | `gpio-leds` | `led` | `gpio-leds` | `led` |
| `buzzer` | `gpio-buzzer` | `buzzer` | `buzzer` | `buzzer` |
| `gpio` | controller’s | `gpio` | `gpio` | `gpio` |

`CLASS_LABELS.keys = 'Keys'`. Order in ▤ view: … → `led` → … → `gpio` →
`keys` → `buzzer` → … (Keys next to GPIO/Buzzer; exact slot: after `gpio`,
before `buzzer`).

### 2.2 `GpioKeysBody`

Move today’s button chrome out of `GpioBody` unchanged:

- Section label: `Inputs — buttons`
- Same momentary `ButtonPin` grid (press/hold → `setInput`)
- No footer blurb

Collapsed badge: `N btn` / `N btns` (what the GPIO badge shows today).

### 2.3 `GpioBody` → pin table only

No buttons, no LED grid. Body is the Proposal B table (below). Collapsed
badge: `claimed / ngpios` (e.g. `2 / 8`).

### 2.4 Sample seeds

| Sample | `primaryPanels` |
| --- | --- |
| Blinky | `['led', 'gpio']` |
| Button | `['keys', 'led', 'gpio']` |
| Buzzer | `['buzzer', 'gpio', 'led']` (keys only if DT has them) |

---

## 3. Pin model (insights + runtime)

### 3.1 From the flattened tree

For each okay consumer on a bridged controller:

| Consumer | Source | Fields |
| --- | --- | --- |
| `gpio-keys` child | existing `buttons` | pin, label, flags |
| `gpio-leds` child | existing `leds` | pin, label, flags |
| `gpio-buzzer` | existing `buzzers` | pin, label, activeHigh → flags |

Flags decode (Zephyr `gpio.h` DT cell, already what `gpioSpecs` returns):

| Bit / combo | UI token |
| --- | --- |
| `GPIO_ACTIVE_LOW` (bit 0) | `AL` |
| else | `AH` |
| `GPIO_PULL_UP` | `PU` |
| `GPIO_PULL_DOWN` | `PD` |
| `GPIO_OPEN_DRAIN` | `OD` |
| `GPIO_OPEN_SOURCE` | `OS` |

Tokens join with a thin space, e.g. `AL PU`. Unknown high bits omitted.

Also keep `ngpios` from the controller node (already on `GpioController`).

### 3.2 From the live bridge

Per pin, when the model exposes it (virtio-gpio direction array today;
host-gpio: treat keys pins as IN, leds/buzzer as OUT when declared):

| Value | UI |
| --- | --- |
| input | `IN` |
| output | `OUT` |
| none / unknown | `—` |

Live level: existing `isInputHigh` / `isOutputHigh` → filled primary dot vs
empty border dot (same language as LED badges).

### 3.3 Which rows appear (Proposal B)

A pin is **claimed** and gets a table row if **any** of:

- DT consumer points at it (keys / leds / buzzer), or
- runtime direction is IN or OUT (guest configured an undeclared line)

Sort by pin index ascending. Unclaimed + undirected pins are omitted.

Fallback with no DT: today’s FALLBACK_BUTTONS (0–3) + FALLBACK_LEDS (4–7) as
claimed consumers, same table shape.

---

## 4. Controller table UI

Compact mono table, no section title chrome beyond the row header:

| Column | Content |
| --- | --- |
| `#` | Pin index |
| `dir` | `IN` / `OUT` / `—` (color: IN = foreground, OUT = primary, — = muted) |
| *(level)* | 7px dot, no header text (matches mockup) |
| `flags` | DT tokens or `—` if no consumer flags |
| `used by` | See §5 |

Row height ~ tight (`py` ≈ 3px). No per-row cards. No footer legend in the
shipped UI (mockup legend was explanatory only).

### 4.1 Interaction on the pin itself

- **`IN` + keys consumer** (or fallback input): the **level cell** (or whole
  row except `used by`) is pressable — same momentary semantics as
  `ButtonPin` (`pointerdown`/`up` → `setInput`). Cursor/keyboard affordance
  on that hit target only.
- **`OUT`**: read-only level.
- Do **not** duplicate a second big button grid on this card.

---

## 5. `used by` → reveal consumer

### 5.1 Cell content

- With consumer: **`SW0` · keys** / **`LED0` · leds** / **`Buzzer` · buzzer**
  — short label bold/foreground, kind muted. Prefer DT `label` stripped to a
  short form when obvious (`Browser SW0` → still show full label if short;
  truncate with ellipsis at ~14ch).
- No consumer (runtime-only claim): `—` (not a link).

### 5.2 Link target

Map consumer → dock row `key`:

| Kind | Target key |
| --- | --- |
| keys | `gpio-keys` |
| leds | `gpio-leds` |
| buzzer | `buzzer` |

(Stable keys already used by topology.)

### 5.3 Click behaviour (`revealDockRow(key)`)

Single helper used by `used by` (and reusable later):

1. **Dock open** — if `state.open === false`, open it.
2. **Unhide** — `setHidden(key, false)` if hidden via Panels menu.
3. **Class group** — if ▤ view and the target’s `deviceClass` group is
   collapsed, expand that group.
4. **Expand row** — `setExpanded(key, true)`.
5. **If windowed** — leave it windowed; focus/blink the floating frame
   instead of the dock row (same key).
6. **Scroll** — `scrollIntoView({ block: 'nearest' })` on the row/frame root.
7. **Blink** — apply attention class for ~900ms (2–3 pulses).

### 5.4 Blink effect

CSS only, no new motion library:

- Target: the **row header** strip (dock) or floating `PanelFrame` header.
- Effect: brief `outline` / background flash using `--color-primary` at low
  alpha (e.g. pulse `background-color` on the header). Prefer
  `prefers-reduced-motion: reduce` → single static highlight ~600ms, no
  pulse.
- Do **not** invent floating badges or toast copy.

### 5.5 Accessibility

- `used by` control is a `<button type="button">` (or link-styled button)
  with `aria-label` like `Reveal GPIO LEDs`.
- After reveal, move focus to the target row’s expand control (or frame), so
  keyboard users land with the blink.

---

## 6. Data wiring sketch

```
insights.gpioControllers[bridged]
  .buttons / .leds / .buzzers / ngpios
        ↓
topology: gpio-keys, gpio-leds, buzzer, gpio rows
        ↓
GpioBody: build claimed pin list
  merge DT consumers + runtime direction
        ↓
table row → used by → revealDockRow(consumerKey)
```

Runtime direction: extend `hostGpio` (or a thin adapter over `gpioModel`) with
`getPinDirection(pin): 'in' | 'out' | 'none'` so M3 MMIO and A53 virtio share
one table path. M3 without a direction register: infer from consumer role
(keys→in, leds/buzzer→out) when DT claims the pin; otherwise `none`.

---

## 7. Out of scope

- Non-bridged GPIO controllers in the tree (stay inert topology rows).
- Editing flags / direction from the UI.
- Showing all `ngpios` idle rows (Proposal A — rejected).
- Footer / shell-hint prose on keys, leds, or controller cards.
- Jump the other way (LED row → controller pin) — nice follow-up, not required.

---

## 8. Acceptance

- Button sample: Keys + LEDs + GPIO table with pins 0 and 4 only (typical).
- Click `SW0 · keys` while Keys is collapsed/hidden → dock shows Keys expanded
  with blink; SW0 still pressable there.
- Click `LED0 · leds` → LEDs row revealed + blink; level tracks blinky.
- Buzzer sample: pin 5 row `used by` → Buzzer; pin 4 → LEDs.
- PWM LED sample unchanged (no bridged GPIO required).
- `npm test` / `typecheck` clean; topology + insights tests cover keys row and
  claimed-only listing.

---

## 9. Confirm

Please confirm or amend:

1. **Proposal B** claimed-only table — yes?
2. **`used by` reveal + blink** as in §5 — yes?
3. **New `keys` PanelKind / Keys class** — yes? (alternative: fold keys under
   an existing class — not recommended)
4. **IN press on the table row** in addition to Keys widget — yes? (keeps
   controller useful alone)
5. Anything to drop from flags tokens (`PU`/`PD`/`OD`/…)?
