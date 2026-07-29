# Add-part file checklist

Use after the skill’s research and UI decision. Paths are from the repo root.

## Layers (stay in sync by `id`)

```text
Zephyr DT compatible(s)
        ↓ COMPAT_TO_CHIP / COMPAT_TO_SPI_CHIP (insights.ts)
parts.ts (identity)  ←→  registry.ts / spiRegistry.ts (create)
        ↓
virtio/index.ts managed singletons + syncManagedChips()
        ↓
deviceTopology.ts (class + body) → deviceBodies.tsx → *Body panel
```

## Typical I²C sensor (framework reuse)

1. `src/virtio/devices/sensors/<id>.ts` — `SensorDecl` (copy a peer like `lm75.ts` / `lps22hh.ts`)
2. `src/virtio/devices/sensors/maps/<id>.json` — when peers ship a register map
3. `src/virtio/devices/registry.ts` — `CHIP_TYPES` + `create()`
4. `src/virtio/devices/parts.ts` — `PARTS` identity (`datasheetUrl`, `bindingUrl`, `compatible`, `kind: 'sensor'`)
5. `src/dts/insights.ts` — **every** Zephyr compatible string → same `id`
6. `src/virtio/index.ts` — singleton + `MANAGED_CHIPS` / `MANAGED_I2C_BY_TYPE`
7. `zephyr-module/snippets/virtio-i2c/` — node (often `disabled` if optional)
8. `zephyr-module/snippets/<id>-only/` — overlay + `snippet.yml` enabling this part
9. `zephyr-module/conf/<id>.conf` — `CONFIG_<DRIVER>=y` as needed
10. `tools/samples.manifest` + `src/boards.ts` — packaged sample / gallery row
11. Tests beside peers; catalog coverage via `src/virtio/devices/parts.test.ts`

## Category frameworks (UI + model — not a bus)

**Kind ≠ bus.** An RTC, DAC, PWM, sensor, etc. can sit on I²C, SPI, or another bridge later. The dock card keys off the category handle (`isRtcChip`, `isDacChip`, …), not off which virtio bus created the chip. Today’s providers happen to be on I²C or SPI; that is packaging, not a rule.

| Category | Declare in | Dock body (reuse) |
| --- | --- | --- |
| Sensor | `sensors/model.ts` | `SensorBody` |
| EEPROM / byte memory | `memory/model.ts` | `MemoryBody` |
| SPI NOR / flash image | `flash/model.ts` | `SpiFlashBody` |
| RTC | `rtc/model.ts` | `RtcBody` |
| PWM controller | `pwm/model.ts` | `PwmBody` (+ `PwmLedsBody` if tree has `pwm-leds`) |
| DAC | `dac/model.ts` | `DacBody` |
| Fuel gauge | `fuel-gauge/model.ts` | `FuelGaugeBody` |

### Bus wiring (pick from the Zephyr binding)

Whatever bus the upstream DT uses:

| Bus | Attach factory | Compatible → id | Managed attach | Guest overlay area |
| --- | --- | --- | --- | --- |
| I²C | `registry.ts` | `COMPAT_TO_CHIP` | `MANAGED_I2C_*` | `snippets/virtio-i2c/`, `*-only` |
| SPI | `spiRegistry.ts` | `COMPAT_TO_SPI_CHIP` | `MANAGED_SPI_*` | virtio-spi overlays / `*-only` |

Same checklist steps as the sensor happy path: `parts.ts` identity, singleton in `virtio/index.ts`, conf + sample packaging. Only the registry / `COMPAT_TO_*` / overlay tree change with the bus.

## When UI topology must change

Only if no existing `BodyKind` fits:

- `src/deviceTopology.ts` — class / body mapping
- `src/components/dock/deviceBodies.tsx` — render branch
- Shared family panel under `src/components/` if several SKUs will share it
- `PartsCatalog.tsx` `KIND_ICONS` / kind labels if introducing a **new** `PartIdentity.kind`

## Compatible alias example (already in tree)

```ts
// insights.ts — one chip id, multiple DT strings
lm75: 'lm75',
'national,lm75': 'lm75',
```

`parts.ts` still lists one primary `compatible` for the identity card; the insights map is what makes alternate nodes attach the same model.

## Zephyr research shortcuts

- Driver: `https://github.com/zephyrproject-rtos/zephyr/tree/main/drivers/...`
- Binding YAML: `https://github.com/zephyrproject-rtos/zephyr/tree/main/dts/bindings/...`
- Binding doc page: `https://docs.zephyrproject.org/latest/build/dts/api/bindings/...`
- In driver sources, search `DT_DRV_COMPAT` and related binding filenames for sibling parts
- MCP: Zephyr Kapa `search_zephyr_knowledge_sources` with the part number and “compatible” / “driver”

## Out of scope for this skill

- New QEMU MMIO bridges / `qemu,host-*` devices — see `docs/next-drivers.md` and `docs/virtio-bridge.md`
- Learner copy tone — use `.cursor/skills/copywriting/`
