/**
 * Guest registry: the machines QEMU can emulate, and the images each can boot.
 *
 * Boards are hardware; images are guest programs. Keep them separate so several
 * images can share a board and a user ELF can replace an image without changing argv.
 *
 * `qemuBinary` must match the Emscripten JS/Wasm artifact: arm, aarch64 or riscv32.
 */

export type PanelKind =
  | 'display'
  | 'gnss'
  | 'sensor'
  | 'gpio'
  | 'keys'
  | 'buzzer'
  | 'audio'
  | 'perf'
  | 'net'
  | 'i2c'
  | 'spi'
  | 'oled'
  | 'auxdisplay'
  | 'led'
  | 'pwm'
  | 'dac'
  | 'fuel-gauge'
  | 'trace'

// QMP monitor bridge; append only when features.json says the emulator has it.
export const MONITOR_ARGS = ['-chardev', 'browser,id=mon0', '-mon', 'chardev=mon0,mode=control']

export interface GuestSample {
  /** Also the artifact basename, so it must stay in step with the build script. */
  id: string
  label: string
  description: string
  zephyrSample: string
  /** Panels expanded on boot; omit for terminal-only samples. */
  primaryPanels?: PanelKind[]
}

export interface Board {
  id: string
  label: string
  zephyrTarget: string
  arch: string
  qemuBinary: string
  args: string[]
  kernelFsPath: string
  peripherals?: {
    gnss?: boolean
    hostGpio?: boolean
    hostAudio?: boolean
    hostMic?: boolean
    ramfb?: boolean
    /** Guest-throughput (MIPS) readout; needs a `-icount` machine to advance. */
    perfStats?: boolean
    /** Ethernet through the `browser` netdev; the page implements the LAN. */
    hostNet?: boolean
    /** Pointer events into a stock `virtio-tablet-device`; needs a display target. */
    hostInput?: boolean
    /** Generic virtio bridge for TypeScript device models under src/virtio/. */
    virtio?: boolean
    /** Poll Emscripten FS for Zephyr's semihosting CTF stream (`tracing.bin`). */
    hostTrace?: boolean
  }
  samples: GuestSample[]
  defaultSampleId: string
  extraFiles?: Array<{ fsPath: string; asset: string }>
  /** True for file_packager bundles (`load.js` + `.data`); false for injected ELFs. */
  usesDataBundle: boolean
}

// Keep Cortex-M3 samples to guests that do not depend on stalled qemu-wasm sleep paths.
const CORTEX_M3_SAMPLES: GuestSample[] = [
  {
    id: 'gnss',
    label: 'GNSS',
    description: 'Parses browser-fed NMEA fixes over UART',
    zephyrSample: 'samples/drivers/gnss',
    primaryPanels: ['gnss'],
  },
  {
    id: 'shell',
    label: 'Shell',
    description: 'Interactive Zephyr shell, with `gpio` and `hostaudio`',
    zephyrSample: 'samples/subsys/shell/shell_module',
    // No I2C bus here; sensor cards are A53-only.
    primaryPanels: ['gpio', 'audio'],
  },
  {
    id: 'hsm',
    label: 'State Machine',
    description: 'Hierarchical state machine driven from the shell',
    zephyrSample: 'samples/subsys/smf/hsm_psicc2',
  },
  {
    id: 'dhcp',
    label: 'DHCP Client',
    description: 'Acquires an IPv4 lease from the browser network',
    zephyrSample: 'samples/net/dhcpv4_client',
    primaryPanels: ['net'],
  },
  {
    id: 'http_server',
    label: 'HTTP Server',
    description: 'Serves a page at 192.0.2.1:8080 — fetch it from the Network panel',
    zephyrSample: 'samples/net/sockets/dumb_http_server',
    primaryPanels: ['net'],
  },
  {
    id: 'http_get',
    label: 'HTTP GET',
    description: 'DNS + TCP fetch of http://google.com through the page proxy',
    zephyrSample: 'samples/net/sockets/http_get',
    primaryPanels: ['net'],
  },
  {
    id: 'hello_world',
    label: 'Hello World',
    description: 'Prints one line and stops',
    zephyrSample: 'samples/hello_world',
  },
  {
    // led0 maps to host-gpio pin 4 (LED0 in the panel).
    id: 'blinky',
    label: 'Blinky',
    description: 'Blinks LED0 on the host GPIO bridge',
    zephyrSample: 'samples/basic/blinky',
    primaryPanels: ['led', 'gpio'],
  },
  {
    id: 'guided',
    label: 'Guided Blinky',
    description: 'Blinky, annotated — it stops and explains itself as it runs',
    zephyrSample: 'zephyr-module/apps/guided_blinky',
    primaryPanels: ['led', 'gpio'],
  },
  {
    // gpio-buzzer is host_gpio pin 5; frequency args are on/off for this backend.
    id: 'buzzer',
    label: 'Buzzer',
    description: 'Drives a gpio-buzzer; the dock shakes and vibrates',
    zephyrSample: 'samples/drivers/buzzer/tone',
    primaryPanels: ['buzzer', 'gpio', 'led'],
  },
  {
    // SW0 is host_gpio pin 0; led0 stays on pin 4.
    id: 'basic_button',
    label: 'Button',
    description: 'A host GPIO button lights an LED via the input subsystem',
    zephyrSample: 'samples/basic/button',
    primaryPanels: ['keys', 'led', 'gpio'],
  },
]

const CORTEX_A53_SAMPLES: GuestSample[] = [
  {
    id: 'gnss',
    label: 'GNSS',
    description: 'Parses browser-fed NMEA fixes over UART',
    zephyrSample: 'samples/drivers/gnss',
    primaryPanels: ['gnss'],
  },
  {
    id: 'display',
    label: 'Display',
    description: 'Draws Zephyr’s display test pattern through qemu,ramfb',
    zephyrSample: 'samples/drivers/display',
    primaryPanels: ['display'],
  },
  {
    id: 'touch',
    label: 'Touch Events',
    description: 'Draws a cross wherever you click the display, over virtio-input',
    zephyrSample: 'samples/subsys/input/draw_touch_events',
    primaryPanels: ['display'],
  },
  {
    id: 'lvgl_music',
    label: 'Music Player',
    description: 'LVGL’s music player on qemu,ramfb — click its controls to drive it',
    zephyrSample: 'samples/modules/lvgl/demos',
    primaryPanels: ['display'],
  },
  {
    id: 'accel_chart',
    label: 'Accelerometer Chart',
    description: 'Browser accelerometer traced live on an LVGL chart',
    // Forked for circular updates and a smaller ramfb the emulated A53 can keep up with.
    zephyrSample: 'zephyr-module/apps/accelerometer_chart',
    primaryPanels: ['sensor', 'display'],
  },
  {
    id: 'lsm6dso',
    label: 'LSM6DSO IMU',
    description: 'Accel + gyro with sensor_attr_set sampling rate, over I²C',
    zephyrSample: 'samples/sensor/lsm6dso',
    primaryPanels: ['sensor', 'i2c'],
  },
  {
    id: 'lps22hh',
    label: 'LPS22HH Pressure',
    description: 'Pressure and temperature from an ST barometer, over I²C',
    zephyrSample: 'samples/sensor/lps22hh',
    primaryPanels: ['sensor', 'i2c'],
  },
  {
    id: 'ina219',
    label: 'INA219 Power',
    description: 'Bus voltage, current and power from an INA219, over I²C',
    zephyrSample: 'samples/sensor/ina219',
    primaryPanels: ['sensor', 'i2c'],
  },
  {
    id: 'isl29035',
    label: 'ISL29035 Light',
    description: 'Ambient light in lux from an ISL29035, over I²C',
    zephyrSample: 'samples/sensor/isl29035',
    primaryPanels: ['sensor', 'i2c'],
  },
  {
    id: 'eeprom',
    label: 'EEPROM',
    description: 'Boot counter that survives reloads in the simulated AT24',
    zephyrSample: 'samples/drivers/eeprom',
    primaryPanels: ['i2c'],
  },
  {
    // W25Q80-class 1 MiB part so the stock spi_flash sample's 0xff000 offset fits.
    id: 'spi_flash',
    label: 'SPI flash',
    description: 'Erase, write and read a JEDEC SPI NOR on the browser SPI bus',
    zephyrSample: 'samples/drivers/spi_flash',
    primaryPanels: ['spi'],
  },
  {
    id: 'littlefs',
    label: 'LittleFS',
    description: 'Boot counter on LittleFS over the browser SPI NOR; survives reload',
    zephyrSample: 'samples/subsys/fs/littlefs',
    primaryPanels: ['spi'],
  },
  {
    id: 'rtc',
    label: 'RTC',
    description: 'Set and read date/time on a PCF8523, over I²C',
    zephyrSample: 'samples/drivers/rtc',
    primaryPanels: ['i2c'],
  },
  {
    id: 'auxdisplay',
    label: 'Aux display',
    description: '“Hello World” on a 16×2 I²C character LCD (JHD1313) in the page',
    zephyrSample: 'samples/drivers/auxdisplay',
    primaryPanels: ['auxdisplay', 'i2c'],
  },
  {
    // Keyscan is off in this HT16K33 packaging.
    id: 'ht16k33',
    label: 'HT16K33 LED',
    description: 'Walks, blinks and dims a 16×8 I²C LED matrix (HT16K33) in the page',
    zephyrSample: 'samples/drivers/ht16k33',
    primaryPanels: ['led', 'i2c'],
  },
  {
    // Browser LP5562 engines approximate led_blink.
    id: 'lp5562',
    label: 'RGB LED',
    description: 'Cycles colors and blinks on a TI LP5562 RGBW LED; orb in the page',
    zephyrSample: 'samples/drivers/led/lp5562',
    primaryPanels: ['led', 'i2c'],
  },
  {
    // LA/OE ride virtio-gpio pins 6/7.
    id: 'sct2024',
    label: 'SCT2024 LED',
    description: 'Walks 16 LEDs on an SCT2024 SPI LED driver; bar + registers in the page',
    zephyrSample: 'samples/drivers/led/sct2024',
    primaryPanels: ['led', 'spi', 'gpio'],
  },
  {
    id: 'pwm_led',
    label: 'PWM LED',
    description: 'Fades and blinks PWM LEDs on a PCA9685; LEDs + duty chart in the page',
    zephyrSample: 'samples/drivers/led/pwm',
    primaryPanels: ['led', 'pwm', 'i2c'],
  },
  {
    // Vendored so the sawtooth loop accounts for virtio-i2c round-trip cost.
    id: 'dac',
    label: 'DAC',
    description: 'Sawtooth on a 12-bit MCP4725; Vout chart in the page',
    zephyrSample: 'zephyr-module/apps/dac_sawtooth',
    primaryPanels: ['dac', 'i2c'],
  },
  {
    id: 'fuel_gauge',
    label: 'Fuel gauge',
    description: 'Polls SoC % and voltage on a MAX17048; battery card in the page',
    zephyrSample: 'samples/drivers/fuel_gauge',
    primaryPanels: ['fuel-gauge', 'i2c'],
  },
  {
    id: 'philosophers',
    label: 'Philosophers',
    description: 'Dining philosophers, animated in-place over VT100',
    zephyrSample: 'samples/philosophers',
  },
  {
    // Writes tracing.bin through semihosting; the Trace panel follows it live.
    id: 'tracing',
    label: 'Tracing',
    description: 'Live CTF schedule view — thread lanes like Zephyr’s trace_viewer',
    zephyrSample: 'samples/subsys/tracing/basic',
    primaryPanels: ['trace'],
  },
  {
    // led0 is pin 4 of the VIRTIO GPIO device.
    id: 'blinky',
    label: 'Blinky',
    description: 'Blinks LED0 over a VIRTIO GPIO device',
    zephyrSample: 'samples/basic/blinky',
    primaryPanels: ['led', 'gpio'],
  },
  {
    id: 'guided',
    label: 'Guided Blinky',
    description: 'Blinky, annotated — it stops and explains itself as it runs',
    zephyrSample: 'zephyr-module/apps/guided_blinky',
    primaryPanels: ['led', 'gpio'],
  },
  {
    // gpio-buzzer is virtio_gpio0 pin 5; LED0 stays on 4.
    id: 'buzzer',
    label: 'Buzzer',
    description: 'Drives a gpio-buzzer over VIRTIO GPIO; the dock shakes and vibrates',
    zephyrSample: 'samples/drivers/buzzer/tone',
    primaryPanels: ['buzzer', 'gpio', 'led'],
  },
  {
    // VIRTIO_GPIO_F_IRQ makes this interrupt-driven, unlike the M3 build.
    id: 'basic_button',
    label: 'Button',
    description: 'A browser button lights an LED, over an interrupt-driven VIRTIO GPIO',
    zephyrSample: 'samples/basic/button',
    primaryPanels: ['keys', 'led', 'gpio'],
  },
  {
    id: 'shell',
    label: 'Shell',
    description:
      'Interactive Zephyr shell, with `i2c`, `sensor`, `rtc`, `flash`, `fs`, `hostaudio` and `dmic`',
    zephyrSample: 'samples/subsys/shell/shell_module',
    primaryPanels: ['i2c', 'spi', 'audio'],
  },
  {
    // Browser SSD1306 over I2C; no framebuffer in this path.
    id: 'oled',
    label: 'OLED',
    description: 'Zephyr’s display test pattern on a 128x64 I2C OLED simulated in the page',
    zephyrSample: 'samples/drivers/display',
    primaryPanels: ['oled', 'i2c'],
  },
  {
    id: 'hsm',
    label: 'State Machine',
    description: 'Hierarchical state machine driven from the shell',
    zephyrSample: 'samples/subsys/smf/hsm_psicc2',
  },
  {
    id: 'dhcp',
    label: 'DHCP Client',
    description: 'Acquires an IPv4 lease from the browser network',
    zephyrSample: 'samples/net/dhcpv4_client',
    primaryPanels: ['net'],
  },
  {
    id: 'http_server',
    label: 'HTTP Server',
    description: 'Serves a page at 192.0.2.1:8080 — fetch it from the Network panel',
    zephyrSample: 'samples/net/sockets/dumb_http_server',
    primaryPanels: ['net'],
  },
  {
    id: 'echo_server',
    label: 'Echo Server',
    description: 'TCP/UDP echo on port 4242 — ping it from the Network panel',
    zephyrSample: 'samples/net/sockets/echo_server',
    primaryPanels: ['net'],
  },
  {
    id: 'http_get',
    label: 'HTTP GET',
    description: 'DNS + TCP fetch of http://google.com through the page proxy',
    zephyrSample: 'samples/net/sockets/http_get',
    primaryPanels: ['net'],
  },
  {
    id: 'zperf',
    label: 'zperf',
    description: 'iperf2-style throughput benchmark against the page',
    zephyrSample: 'samples/net/zperf',
    primaryPanels: ['net'],
  },
  {
    id: 'hello_world',
    label: 'Hello World',
    description: 'Prints one line and stops',
    zephyrSample: 'samples/hello_world',
  },
]

export const BOARDS: Board[] = [
  {
    id: 'qemu_cortex_m3',
    label: 'QEMU Cortex-M3',
    zephyrTarget: 'qemu_cortex_m3',
    arch: 'ARMv7-M',
    qemuBinary: 'qemu-system-arm',
    args: [
      '-nographic',
      '-machine',
      'lm3s6965evb',
      '-cpu',
      'cortex-m3',
      // Only `-nic` can attach the browser backend to this sysbus NIC.
      '-nic',
      'browser,model=stellaris',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    kernelFsPath: '/pack/zephyr.elf',
    peripherals: {
      gnss: true,
      hostGpio: true,
      hostAudio: true,
      hostMic: true,
      hostNet: true,
    },
    samples: CORTEX_M3_SAMPLES,
    defaultSampleId: 'shell',
    usesDataBundle: false,
  },
  {
    id: 'qemu_cortex_a53',
    label: 'QEMU Cortex-A53',
    zephyrTarget: 'qemu_cortex_a53',
    arch: 'ARMv8-A',
    qemuBinary: 'qemu-system-aarch64',
    args: [
      '-nographic',
      '-machine',
      'virt,secure=on,gic-version=3',
      '-cpu',
      'cortex-a53',
      '-device',
      'ramfb',
      '-vga',
      'none',
      '-L',
      '/pack/pc-bios',
      // Do not enable -icount here; it roughly halves synchronous virtio throughput.
      '-rtc',
      'clock=vm',
      // ARM semihosting lets hostTrace poll ./tracing.bin from the Emscripten FS.
      '-semihosting',
      // Zephyr's virtio-mmio driver only speaks modern transports.
      '-global',
      'virtio-mmio.force-legacy=false',
      // MAC must match the shield overlay; QEMU filters inbound unicast against it.
      '-netdev',
      'browser,id=n0',
      '-device',
      'virtio-net-device,netdev=n0,bus=virtio-mmio-bus.0,mac=02:00:00:00:00:01',
      // Slot 3 matches Zephyr board.cmake, so native `west build -t run` has the same tablet wiring.
      '-device',
      'virtio-tablet-device,bus=virtio-mmio-bus.3',
      // Generic bridge binds `name=gpio` to src/virtio/devices/gpio.ts.
      // Config is read before the page attaches, so ngpio=8 must live in argv and match the overlay.
      '-device',
      'virtio-browser-device,bus=virtio-mmio-bus.2,name=gpio,device-id=41,' +
        'queues=2,features=0x1,config=0800000000000000',
      // I2C chips are page-side TypeScript models; the adapter has no config space.
      '-device',
      'virtio-browser-device,bus=virtio-mmio-bus.4,name=i2c,device-id=34,queues=1',
      // Requires the VIRTIO_ID_SPI backport; older emulator artifacts abort in virtio_id_to_name.
      '-device',
      'virtio-browser-device,bus=virtio-mmio-bus.5,name=spi,device-id=45,' +
        'queues=1,config=04010000800000000f00000080f0fa0200000000000000000000000000000000',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    kernelFsPath: '/pack/zephyr.elf',
    peripherals: {
      gnss: true,
      hostGpio: true,
      hostAudio: true,
      hostMic: true,
      ramfb: true,
      hostInput: true,
      hostNet: true,
      virtio: true,
      hostTrace: true,
    },
    samples: CORTEX_A53_SAMPLES,
    defaultSampleId: 'shell',
    extraFiles: [
      { fsPath: '/pack/pc-bios/vgabios-ramfb.bin', asset: 'vgabios-ramfb.bin' },
      { fsPath: '/pack/pc-bios/efi-virtio.rom', asset: 'efi-virtio.rom' },
    ],
    usesDataBundle: false,
  },
  {
    id: 'qemu_riscv32',
    label: 'QEMU RISC-V 32',
    zephyrTarget: 'qemu_riscv32',
    arch: 'RV32IMAFDC',
    qemuBinary: 'qemu-system-riscv32',
    args: [
      '-nographic',
      '-machine',
      'virt',
      '-bios',
      'none',
      '-m',
      '256',
      // Pin PMP/M-mode CPU flags to match Zephyr qemu_riscv32 and avoid QEMU's satp warning.
      '-cpu',
      'rv32i,i=on,m=on,a=on,f=on,d=on,c=on,zicsr=on,zifencei=on,pmp=on,u=on,sv32=off',
      '-device',
      'ramfb',
      '-vga',
      'none',
      '-L',
      '/pack/pc-bios',
      '-global',
      'virtio-mmio.force-legacy=false',
      '-netdev',
      'browser,id=n0',
      '-device',
      'virtio-net-device,netdev=n0,bus=virtio-mmio-bus.0,mac=02:00:00:00:00:01',
      '-device',
      'virtio-tablet-device,bus=virtio-mmio-bus.3',
      '-device',
      'virtio-browser-device,bus=virtio-mmio-bus.2,name=gpio,device-id=41,' +
        'queues=2,features=0x1,config=0800000000000000',
      '-device',
      'virtio-browser-device,bus=virtio-mmio-bus.4,name=i2c,device-id=34,queues=1',
      // Requires the VIRTIO_ID_SPI backport; older emulator artifacts abort in virtio_id_to_name.
      '-device',
      'virtio-browser-device,bus=virtio-mmio-bus.5,name=spi,device-id=45,' +
        'queues=1,config=04010000800000000f00000080f0fa0200000000000000000000000000000000',
      '-kernel',
      '/pack/zephyr.elf',
    ],
    kernelFsPath: '/pack/zephyr.elf',
    peripherals: {
      gnss: true,
      hostGpio: true,
      hostAudio: true,
      hostMic: true,
      ramfb: true,
      hostInput: true,
      hostNet: true,
      virtio: true,
    },
    // Same guest apps as A53, minus tracing (ARM semihosting CTF path).
    samples: CORTEX_A53_SAMPLES.filter((s) => s.id !== 'tracing'),
    defaultSampleId: 'hello_world',
    extraFiles: [
      { fsPath: '/pack/pc-bios/vgabios-ramfb.bin', asset: 'vgabios-ramfb.bin' },
      { fsPath: '/pack/pc-bios/efi-virtio.rom', asset: 'efi-virtio.rom' },
    ],
    usesDataBundle: false,
  },
]

export const DEFAULT_BOARD_ID = 'qemu_cortex_a53'

export function getBoard(id: string): Board {
  return BOARDS.find((b) => b.id === id) ?? BOARDS.find((b) => b.id === DEFAULT_BOARD_ID)!
}

export function getSample(board: Board, sampleId: string): GuestSample {
  return board.samples.find((s) => s.id === sampleId) ?? board.samples[0]
}

export function samplePrimaryPanels(board: Board, sampleId: string): Set<PanelKind> {
  return new Set(getSample(board, sampleId).primaryPanels)
}

export function sampleAsset(board: Board, sampleId: string): string {
  return `zephyr/${board.zephyrTarget}/${sampleId}.elf`
}

/** Flattened devicetree next to the image; older tarballs may not have it. */
export function sampleDtsAsset(board: Board, sampleId: string): string {
  return `zephyr/${board.zephyrTarget}/${sampleId}.dts`
}

/** Optional walkthrough catalog next to annotated samples. */
export function sampleAnnotationsAsset(board: Board, sampleId: string): string {
  return `zephyr/${board.zephyrTarget}/${sampleId}.annotations.json`
}

/** Shipped source with `@annotate` blocks stripped so catalog line numbers match. */
export function sampleSourceAsset(board: Board, sampleId: string, file: string): string {
  return `zephyr/${board.zephyrTarget}/src/${sampleId}/${file}`
}
