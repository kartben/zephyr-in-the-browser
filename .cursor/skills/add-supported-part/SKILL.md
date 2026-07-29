---
name: add-supported-part
description: Add a new simulated silicon part (sensor, EEPROM, display, LED, PWM, DAC, fuel gauge, RTC, flash, stepper, CAN) to Zephyr in the Browser. Use when the user asks to support, simulate, or add a chip/part/peripheral, wire a Zephyr driver over virtio-i2c/spi, or extend the parts catalog.
---

# Add a supported part

Help someone model **real silicon** so the guest binds an **unmodified in-tree Zephyr driver** while the page answers the bus in TypeScript and shows a dock card.

Canonical maintainer narrative: [docs/peripherals.md](../../../docs/peripherals.md). File-by-file checklist: [checklist.md](checklist.md).

## Before writing code

### 1. Require a datasheet

Ask for a **public datasheet URL** (PDF or manufacturer page) before implementing register behaviour.

- Put it on the identity card as `datasheetUrl` in `src/virtio/devices/parts.ts`.
- If they only have a part number, help find an official link; do not invent electrical behaviour from memory when the sheet is missing.
- Prefer the sheet the Zephyr driver was written against when versions differ.

### 2. Research Zephyr (driver + bindings)

Do **not** assume one `compatible` string. Check upstream before picking an id:

| Source | What to find |
| --- | --- |
| [Zephyr drivers](https://github.com/zephyrproject-rtos/zephyr/tree/main/drivers) | Driver source, `DT_DRV_COMPAT`, shared headers, Kconfig |
| [Zephyr bindings](https://github.com/zephyrproject-rtos/zephyr/tree/main/dts/bindings) | YAML `compatible`, `on-bus`, required properties |
| [Bindings docs](https://docs.zephyrproject.org/latest/build/dts/api/bindings.html) | Human-readable binding page URL for `bindingUrl` |
| Zephyr Kapa MCP (`search_zephyr_knowledge_sources`) | Driver family, samples, API class |

Also scan this repo’s existing maps: `COMPAT_TO_CHIP` / `COMPAT_TO_SPI_CHIP` in `src/dts/insights.ts`.

### 3. Map every compatible the driver family accepts

Zephyr often treats related parts as one programming model:

- Fallback lists on the node: `compatible = "st,lis2dh12", "st,lis2dh";`
- Aliases / vendor renames: this tree already maps both `lm75` and `national,lm75` → `lm75`
- One driver `.c` with multiple `DT_DRV_COMPAT` / binding YAML files that share register layout

**Rule:** one browser chip model (one `id`) must answer **every** DT compatible that would bind a guest driver expecting that bus behaviour. Add **each** string to `COMPAT_TO_CHIP` or `COMPAT_TO_SPI_CHIP`. If samples or shields use different primary compatibles for the same silicon family, package and test those variants (or document which overlay string is canonical and still map the others).

If two compatibles are **not** wire-compatible (different register maps or protocols), they are separate parts — do not collapse them.

### 4. Pick the smallest reusable UI

Default: **declaration into an existing framework**, not a new panel. Docs line: *adding a part is a declaration, not another panel*.

**Category ≠ bus.** Choose the framework from what the part *is* (sensor, RTC, DAC, …). The bus (I²C, SPI, …) comes from the Zephyr binding and only changes which registry / `COMPAT_TO_*` / overlay you wire — not which dock body. A SPI RTC should still reuse `RtcBody`.

| Category | Prefer | Dock body |
| --- | --- | --- |
| Temperature, pressure, light, IMU, power monitor, … | `sensors/model.ts` + map JSON | `SensorBody` |
| EEPROM / byte-addressable memory | `memory/model.ts` | `MemoryBody` |
| Flash / NOR image | `flash/model.ts` | `SpiFlashBody` |
| RTC | `rtc/model.ts` | `RtcBody` |
| PWM controller | `pwm/model.ts` | `PwmBody` |
| DAC | `dac/model.ts` | `DacBody` |
| Fuel gauge | `fuel-gauge/model.ts` | `FuelGaugeBody` |
| Aux character / VFD-style | Shared auxdisplay surface | `AuxdisplayBody` |
| RGB / banked LED controllers | Shared LED surface | `RgbLedBody` (or existing matrix/bar bodies) |

**Happy path:** another thermometer or barometer is mostly copy-an-existing-decl (e.g. `sensors/lm75.ts`) + packaging. Little or no new React.

### 5. New UI only when the part is truly different — ask first

Create or extend a dedicated widget only when the interaction cannot fit a shared body, e.g. command-stream displays (SSD1306), LED matrix/bar decode, stepper motion dial, CAN host network, bitstream LEDs (WS2812).

When that seems necessary:

1. Say what existing body almost fits and what it cannot show.
2. Offer alternatives: stick to registers + category sliders; extend a shared family panel; or add a focused reusable widget (prefer family reuse over a one-off card).
3. **Ask the user** which trade-off they want before scaffolding new React.
4. If building new UI, design for the next similar part (shared `BodyKind`, props from the chip model), not a single SKU.

Learner-facing strings: follow the [copywriting](../copywriting/SKILL.md) skill.

## Implementation order

1. Confirm datasheet + Zephyr driver/bindings + compatible set.
2. Choose framework / UI path (reuse vs ask about new UI).
3. Implement chip model (+ register map JSON when peers have one).
4. Wire identity (`parts.ts`); attach on the bus the Zephyr binding uses (`registry.ts` vs `spiRegistry.ts`, matching `COMPAT_TO_*`); managed attach in `virtio/index.ts`.
5. Package guest side: overlay / `*-only` snippet, `conf/<id>.conf`, `tools/samples.manifest`, gallery row in `src/boards.ts` when there is a demo sample.
6. Topology / `deviceBodies.tsx` only if no existing `BodyKind` fits.
7. Tests as peers do; `parts.test.ts` requires every attach type in `PARTS` (with datasheet).

Stable **id**: lowercase part stem (`tmp112`, `lps22hh`, `w25q`). Same id across PARTS, registries, `COMPAT_TO_*`, managed maps, snippets, and usually the sample id.

## Do / don’t

**Do**

- Simulate the chip on virtio-i2c / virtio-spi so the guest uses stock drivers
- Keep DT as source of truth (`syncManagedChips` attaches only while nodes are okay)
- Map all driver-family compatibles to one model when behaviour matches
- Reuse category UI; keep cards declaration-driven

**Don’t**

- Invent a bespoke MMIO/`qemu,host-*` device when a real bus part exists upstream
- Add a new dock panel for a part that fits sensor/memory/rtc/pwm/dac/fuel-gauge
- Catalog synthetic helpers (e.g. SPI `loopback` stays `catalogued: false`)
- Ship without `datasheetUrl` on the `PARTS` entry when a public sheet exists

## Quick checks before finishing

- [ ] Datasheet URL collected and stored on the part identity
- [ ] Zephyr driver + binding(s) checked; all relevant compatibles mapped in `insights.ts`
- [ ] UI reuses the category body, or user agreed to a reusable dedicated widget
- [ ] `parts.ts` + bus registry + managed singletons + packaging aligned on one `id`
- [ ] Peer-style tests pass; catalog invariants satisfied
