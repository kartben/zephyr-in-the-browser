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

## Other declaration frameworks

| Kind | Model / chip dir | Registry | Body (usually unchanged) |
| --- | --- | --- | --- |
| EEPROM | `memory/` | I²C `registry.ts` | `MemoryBody` |
| RTC | `rtc/` | I²C | `RtcBody` |
| PWM | `pwm/` | I²C | `PwmBody` (+ `PwmLedsBody` if `pwm-leds`) |
| DAC | `dac/` | I²C | `DacBody` |
| Fuel gauge | `fuel-gauge/` | I²C | `FuelGaugeBody` |
| SPI NOR | `flash/` | `spiRegistry.ts` | `SpiFlashBody` |

SPI parts: also `COMPAT_TO_SPI_CHIP`, SPI managed maps, SPI overlay / snippets.

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
