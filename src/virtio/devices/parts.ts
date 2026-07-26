/**
 * Identity cards for every simulated part the page can attach.
 *
 * The attach pickers ({@link ./registry.ts}, SPI panel) own *how* to build a
 * chip; this module owns *who it is* — manufacturer, Zephyr compatible,
 * datasheet, binding docs — so the parts catalog and live chip UIs can show
 * the same card without each panel inventing its own links.
 */

export type PartBus = 'i2c' | 'spi'

/**
 * Static identity for one supported part. Keys match {@link CHIP_TYPES} /
 * SPI attach ids (and DT `chipId` where the overlay names one).
 */
export interface PartIdentity {
  /** Stable id — same as the attach picker's value / DT chipId. */
  id: string
  /** Human label shown in the catalog and attach picker. */
  label: string
  manufacturer: string
  /** Official part number (e.g. `TMP112`, `W25Q80BV`). */
  part: string
  bus: PartBus
  /** Zephyr DT compatible string the stock driver binds to. */
  compatible: string
  /**
   * Default I²C address (7-bit) or SPI chip-select. Interpreted with
   * {@link addressKind}.
   */
  defaultAddress: number
  addressKind: 'i2c' | 'spi-cs'
  /** Optional second I²C endpoint (JHD1313 backlight). */
  secondaryAddress?: number
  secondaryLabel?: string
  /** Peripheral class for grouping in the catalog. */
  kind:
    | 'sensor'
    | 'eeprom'
    | 'display'
    | 'auxdisplay'
    | 'led'
    | 'pwm'
    | 'dac'
    | 'fuel-gauge'
    | 'rtc'
    | 'flash'
  /** Official datasheet URL when one is publicly linkable. */
  datasheetUrl?: string
  /** Zephyr DT binding documentation URL. */
  bindingUrl?: string
  /** One sentence: what the browser model covers. */
  summary: string
}

const ZEPHYR_BINDING =
  'https://docs.zephyrproject.org/latest/build/dts/api/bindings'

function binding(path: string): string {
  return `${ZEPHYR_BINDING}/${path}`
}

/**
 * Every real silicon part the page models. Synthetic helpers (SPI loopback)
 * stay out — they are attach tools, not identity cards.
 */
export const PARTS: readonly PartIdentity[] = [
  {
    id: 'tmp112',
    label: 'TMP112 temperature',
    manufacturer: 'Texas Instruments',
    part: 'TMP112',
    bus: 'i2c',
    compatible: 'ti,tmp112',
    defaultAddress: 0x48,
    addressKind: 'i2c',
    kind: 'sensor',
    datasheetUrl: 'https://www.ti.com/lit/ds/symlink/tmp112.pdf',
    bindingUrl: binding('sensor/ti%2Ctmp112.html'),
    summary: 'Digital thermometer; stock Zephyr `ti,tmp112` over virtio-i2c.',
  },
  {
    id: 'lm75',
    label: 'LM75 temperature',
    manufacturer: 'NXP',
    part: 'LM75B',
    bus: 'i2c',
    compatible: 'lm75',
    defaultAddress: 0x49,
    addressKind: 'i2c',
    kind: 'sensor',
    datasheetUrl: 'https://www.nxp.com/docs/en/data-sheet/LM75B.pdf',
    bindingUrl: binding('sensor/lm75.html'),
    summary: 'Classic I²C temperature sensor; Zephyr `lm75` binding.',
  },
  {
    id: 'adxl345',
    label: 'ADXL345 accelerometer',
    manufacturer: 'Analog Devices',
    part: 'ADXL345',
    bus: 'i2c',
    compatible: 'adi,adxl345',
    defaultAddress: 0x53,
    addressKind: 'i2c',
    kind: 'sensor',
    datasheetUrl:
      'https://www.analog.com/media/en/technical-documentation/data-sheets/adxl345.pdf',
    bindingUrl: binding('sensor/adi%2Cadxl345.html'),
    summary: '3-axis accel; can follow the browser device’s real tilt.',
  },
  {
    id: 'lsm6dso',
    label: 'LSM6DSO IMU',
    manufacturer: 'STMicroelectronics',
    part: 'LSM6DSO',
    bus: 'i2c',
    compatible: 'st,lsm6dso',
    defaultAddress: 0x6a,
    addressKind: 'i2c',
    kind: 'sensor',
    datasheetUrl: 'https://www.st.com/resource/en/datasheet/lsm6dso.pdf',
    bindingUrl: binding('sensor/st%2Clsm6dso.html'),
    summary: '6-axis IMU; ODR follows Zephyr `sensor_attr_set` writes.',
  },
  {
    id: 'lps22hh',
    label: 'LPS22HH pressure',
    manufacturer: 'STMicroelectronics',
    part: 'LPS22HH',
    bus: 'i2c',
    compatible: 'st,lps22hh',
    defaultAddress: 0x5c,
    addressKind: 'i2c',
    kind: 'sensor',
    datasheetUrl: 'https://www.st.com/resource/en/datasheet/lps22hh.pdf',
    bindingUrl: binding('sensor/st%2Clps22hh.html'),
    summary: 'Barometric pressure / temperature sensor.',
  },
  {
    id: 'ina219',
    label: 'INA219 power monitor',
    manufacturer: 'Texas Instruments',
    part: 'INA219',
    bus: 'i2c',
    compatible: 'ti,ina219',
    defaultAddress: 0x40,
    addressKind: 'i2c',
    kind: 'sensor',
    datasheetUrl: 'https://www.ti.com/lit/ds/symlink/ina219.pdf',
    bindingUrl: binding('sensor/ti%2Cina219.html'),
    summary: 'High-side current / power / bus-voltage monitor.',
  },
  {
    id: 'isl29035',
    label: 'ISL29035 light',
    manufacturer: 'Renesas',
    part: 'ISL29035',
    bus: 'i2c',
    compatible: 'isil,isl29035',
    defaultAddress: 0x44,
    addressKind: 'i2c',
    kind: 'sensor',
    datasheetUrl:
      'https://www.renesas.com/en/document/dst/isl29035-datasheet',
    bindingUrl: binding('sensor/isil%2Cisl29035.html'),
    summary: 'Digital ambient light sensor.',
  },
  {
    id: 'at24',
    label: 'AT24C02 EEPROM',
    manufacturer: 'Microchip',
    part: 'AT24C02C',
    bus: 'i2c',
    compatible: 'atmel,at24',
    defaultAddress: 0x50,
    addressKind: 'i2c',
    kind: 'eeprom',
    datasheetUrl:
      'https://ww1.microchip.com/downloads/en/DeviceDoc/AT24C02C-AT24C16C-I2C-Compatible-Two-Wire-Serial-EEPROM-20057658A.pdf',
    bindingUrl: binding('mtd/atmel%2Cat24.html'),
    summary: '2 Kbit I²C EEPROM; hex dump persists across reloads.',
  },
  {
    id: 'ssd1306',
    label: 'SSD1306 OLED',
    manufacturer: 'Solomon Systech',
    part: 'SSD1306',
    bus: 'i2c',
    compatible: 'solomon,ssd1306',
    defaultAddress: 0x3c,
    addressKind: 'i2c',
    kind: 'display',
    datasheetUrl: 'https://cdn-shop.adafruit.com/datasheets/SSD1306.pdf',
    bindingUrl: binding('display/solomon%2Cssd1306fb-i2c.html'),
    summary: '128×64 OLED controller; GDDRAM painted live in the dock.',
  },
  {
    id: 'jhd1313',
    label: 'JHD1313 LCD (+ backlight)',
    manufacturer: 'JHD / Seeed',
    part: 'JHD1313',
    bus: 'i2c',
    compatible: 'jhd,jhd1313',
    defaultAddress: 0x3e,
    addressKind: 'i2c',
    secondaryAddress: 0x62,
    secondaryLabel: 'backlight',
    kind: 'auxdisplay',
    datasheetUrl: 'https://wiki.seeedstudio.com/Grove-LCD_RGB_Backlight/',
    bindingUrl: binding('auxdisplay/jhd%2Cjhd1313.html'),
    summary: 'Grove 16×2 RGB LCD: HD44780-ish @ 0x3e + backlight @ 0x62.',
  },
  {
    id: 'ht16k33',
    label: 'HT16K33 LED matrix',
    manufacturer: 'Holtek',
    part: 'HT16K33',
    bus: 'i2c',
    compatible: 'holtek,ht16k33',
    defaultAddress: 0x70,
    addressKind: 'i2c',
    kind: 'led',
    datasheetUrl: 'https://cdn-shop.adafruit.com/datasheets/ht16K33v110.pdf',
    bindingUrl: binding('led/holtek%2Cht16k33.html'),
    summary: '16×8 LED matrix driver with dimming.',
  },
  {
    id: 'lp5562',
    label: 'LP5562 RGBW LED',
    manufacturer: 'Texas Instruments',
    part: 'LP5562',
    bus: 'i2c',
    compatible: 'ti,lp5562',
    defaultAddress: 0x30,
    addressKind: 'i2c',
    kind: 'led',
    datasheetUrl: 'https://www.ti.com/lit/ds/symlink/lp5562.pdf',
    bindingUrl: binding('led/ti%2Clp5562.html'),
    summary: '4-channel RGBW LED driver with execution engines.',
  },
  {
    id: 'pca9685',
    label: 'PCA9685 PWM',
    manufacturer: 'NXP',
    part: 'PCA9685',
    bus: 'i2c',
    compatible: 'nxp,pca9685-pwm',
    defaultAddress: 0x60,
    addressKind: 'i2c',
    kind: 'pwm',
    datasheetUrl: 'https://www.nxp.com/docs/en/data-sheet/PCA9685.pdf',
    bindingUrl: binding('pwm/nxp%2Cpca9685-pwm.html'),
    summary: '16-channel 12-bit PWM controller; drives `pwm-leds`.',
  },
  {
    id: 'mcp4725',
    label: 'MCP4725 DAC',
    manufacturer: 'Microchip',
    part: 'MCP4725',
    bus: 'i2c',
    compatible: 'microchip,mcp4725',
    defaultAddress: 0x61,
    addressKind: 'i2c',
    kind: 'dac',
    datasheetUrl:
      'https://ww1.microchip.com/downloads/en/DeviceDoc/22039d.pdf',
    bindingUrl: binding('dac/microchip%2Cmcp4725.html'),
    summary: '12-bit I²C DAC with EEPROM; dock charts Vout.',
  },
  {
    id: 'max17048',
    label: 'MAX17048 fuel gauge',
    manufacturer: 'Analog Devices',
    part: 'MAX17048',
    bus: 'i2c',
    compatible: 'maxim,max17048',
    defaultAddress: 0x36,
    addressKind: 'i2c',
    kind: 'fuel-gauge',
    datasheetUrl:
      'https://www.analog.com/media/en/technical-documentation/data-sheets/max17048-max17049.pdf',
    bindingUrl: binding('fuel-gauge/maxim%2Cmax17048.html'),
    summary: 'ModelGauge SoC / voltage fuel gauge.',
  },
  {
    id: 'pcf8523',
    label: 'PCF8523 RTC',
    manufacturer: 'NXP',
    part: 'PCF8523',
    bus: 'i2c',
    compatible: 'nxp,pcf8523',
    defaultAddress: 0x68,
    addressKind: 'i2c',
    kind: 'rtc',
    datasheetUrl: 'https://www.nxp.com/docs/en/data-sheet/PCF8523.pdf',
    bindingUrl: binding('rtc/nxp%2Cpcf8523.html'),
    summary: 'Real-time clock with alarms; sync from the browser clock.',
  },
  {
    id: 'w25q',
    label: 'W25Q SPI NOR',
    manufacturer: 'Winbond',
    part: 'W25Q80BV',
    bus: 'spi',
    compatible: 'jedec,spi-nor',
    defaultAddress: 0,
    addressKind: 'spi-cs',
    kind: 'flash',
    datasheetUrl:
      'https://www.winbond.com/resource-files/w25q80bv_revh_10022015.pdf',
    bindingUrl: binding('mtd/jedec%2Cspi-nor.html'),
    summary: '1 MiB JEDEC SPI NOR; hex dump + LittleFS browser.',
  },
  {
    id: 'sct2024',
    label: 'SCT2024 LED',
    manufacturer: 'StarChips',
    part: 'SCT2024',
    bus: 'spi',
    compatible: 'sct,sct2024',
    defaultAddress: 0,
    addressKind: 'spi-cs',
    kind: 'led',
    datasheetUrl: 'https://www.starchips.com.tw/pdf/datasheet/SCT2024V01_03.pdf',
    bindingUrl: binding('led/sct%2Csct2024.html'),
    summary: '16-channel constant-current LED sink over SPI.',
  },
]

const BY_ID = new Map(PARTS.map((p) => [p.id, p]))
const BY_COMPATIBLE = new Map(PARTS.map((p) => [p.compatible, p]))

/** Lookup by attach / DT chip id. */
export function partById(id: string): PartIdentity | undefined {
  return BY_ID.get(id)
}

/** Lookup by Zephyr compatible string. */
export function partByCompatible(compatible: string): PartIdentity | undefined {
  return BY_COMPATIBLE.get(compatible)
}

/** Compatibles used when a tree does not name the part. */
export function partCompatible(id: string): string | undefined {
  return BY_ID.get(id)?.compatible
}

export const PART_KIND_LABELS: Record<PartIdentity['kind'], string> = {
  sensor: 'Sensor',
  eeprom: 'EEPROM',
  display: 'Display',
  auxdisplay: 'Character LCD',
  led: 'LED',
  pwm: 'PWM',
  dac: 'DAC',
  'fuel-gauge': 'Fuel gauge',
  rtc: 'RTC',
  flash: 'Flash',
}
