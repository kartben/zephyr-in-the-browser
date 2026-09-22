import { describe, expect, it } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import fixture from '@/dts/fixtures/esp32c3_devkitc_watchdog.dts?raw'
import { deriveDeviceInventory, type Availability } from '@/deviceTopology'

const NONE: Availability = {
  gnss: false,
  bluetooth: false,
  gpio: false,
  audio: false,
  mic: false,
  net: false,
  i2c: false,
  spi: false,
  can: false,
  power: false,
  watchdog: false,
  display: false,
  input: false,
  disk: false,
}

const inventory = (avail: Availability, text = fixture, board = 'esp32c3_devkitc') => {
  const doc = parseDts(text)
  return deriveDeviceInventory(
    { name: 'watchdog.dts', doc, insights: computeInsights(doc) },
    [],
    [],
    avail,
    board,
  )
}

/** The node the watchdog snippet enables on each of the other two boards. */
const socWith = (node: string) => `/dts-v1/;
/ {
	#address-cells = < 0x1 >;
	#size-cells = < 0x1 >;
	soc {
		#address-cells = < 0x1 >;
		#size-cells = < 0x1 >;
		compatible = "simple-bus";
		ranges;
		${node}
	};
};
`
const M3 = socWith(`wdt0: watchdog@40000000 {
			compatible = "arm,cmsdk-watchdog";
			reg = < 0x40000000 0x1000 >;
			status = "okay";
		};`)
const RISCV = socWith(`wdt0: watchdog@1000d000 {
			compatible = "sifive,wdt";
			reg = < 0x1000d000 0x1000 >;
			interrupts = < 0xe 0x1 >;
			status = "okay";
		};`)

describe('watchdog dock topology', () => {
  it('lists only the enabled timer group, placed on TIMG0', () => {
    const doc = parseDts(fixture)
    expect(computeInsights(doc).watchdogs).toMatchObject([
      { controllerLabel: 'wdt0', address: 0x6001f048 },
    ])

    const rows = inventory({ ...NONE, watchdog: true }).nodes.filter(
      (n) => n.deviceClass === 'watchdog',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      presence: 'interactive',
      body: 'watchdog',
      watchdog: { source: 'esp', index: 0 },
      compatible: 'espressif,esp32-watchdog',
      panelKind: 'watchdog',
    })
  })

  it.each([
    ['qemu_cortex_m3', M3, 'arm,cmsdk-watchdog'],
    ['qemu_riscv32', RISCV, 'sifive,wdt'],
  ])('puts the %s watchdog on the upstream models\' block', (board, text, compatible) => {
    const rows = inventory({ ...NONE, watchdog: true }, text, board).nodes.filter(
      (n) => n.deviceClass === 'watchdog',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      presence: 'interactive',
      compatible,
      watchdog: { source: 'browser', index: 0 },
    })
  })

  it('stays inert until the emulator reports on it', () => {
    const rows = inventory(NONE).nodes.filter((n) => n.deviceClass === 'watchdog')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ presence: 'inert', body: undefined })
  })
})
