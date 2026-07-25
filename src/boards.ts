/**
 * Guest registry: the machines QEMU can emulate, and the images each can boot.
 *
 * A board is *hardware* — machine model, CPU, argv. An image is a *program* that
 * runs on it. They are deliberately separate: several images run on one board,
 * and a user-supplied ELF replaces the image without touching the machine.
 *
 * `qemuBinary` selects the matching Emscripten JS/Wasm artifact pair. The
 * Cortex-M3 uses arm-softmmu; the 64-bit `virt` machine needed by qemu,ramfb
 * uses aarch64-softmmu; `qemu_riscv32` uses riscv32-softmmu on the RISC-V
 * `virt` machine (also with virtio-mmio and ramfb).
 */

/** A peripheral bridge with a floating panel in the UI. */
export type PanelKind =
  | 'display'
  | 'gnss'
  | 'sensor'
  | 'gpio'
  | 'buzzer'
  | 'audio'
  | 'perf'
  | 'net'
  | 'i2c'
  | 'oled'
  | 'auxdisplay'
  | 'led'
  | 'pwm'
  | 'dac'
  | 'fuel-gauge'
  | 'trace'

/** A prebuilt guest image. Produced by tools/build-zephyr-image.sh. */
export interface GuestSample {
  /** Also the artifact basename, so it must stay in step with the build script. */
  id: string
  label: string
  /** One line, shown under the label in the picker. */
  description: string
  /**
   * Zephyr sample path, relative to the zephyr/ tree — or one of this repo's
   * own apps when it starts with "zephyr-module/".
   */
  zephyrSample: string
  /**
   * Panels this sample is *about* — expanded on boot so the relevant bridge is
   * in view immediately. Every other available panel starts collapsed, since it
   * is incidental to what the sample demonstrates. Omit for samples that only
   * speak over the terminal.
   */
  primaryPanels?: PanelKind[]
}

export interface Board {
  id: string
  label: string
  /** Zephyr board target, i.e. `west build -b <zephyrTarget>`. */
  zephyrTarget: string
  /** Guest architecture, for display. */
  arch: string
  /** Emscripten artifact basename, e.g. `qemu-system-arm`. */
  qemuBinary: string
  /** QEMU argv, passed as Module.arguments (argv[0] is implicit). */
  args: string[]
  /** Where the kernel lands in the Emscripten filesystem; matches `-kernel`. */
  kernelFsPath: string
  /** Optional browser bridges physically present on this machine. */
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
    /**
     * Pointer events into a stock `virtio-tablet-device`, making the display
     * panel a touch surface. Needs both the emulator's input bridge and a
     * `ramfb` (or virtio-gpu) panel to aim at.
     */
    hostInput?: boolean
    /**
     * The generic virtio bridge — `-device virtio-browser-device`, whose device
     * models are TypeScript under src/virtio/. Needs a virtio-mmio bus (ARM
     * and RISC-V `virt`). See docs/virtio-bridge.md.
     */
    virtio?: boolean
    /**
     * Poll Emscripten FS for Zephyr's semihosting CTF stream (`tracing.bin`).
     * Needs `-semihosting` on the argv; the Trace stage panel follows it.
     */
    hostTrace?: boolean
  }
  samples: GuestSample[]
  defaultSampleId: string
  /**
   * Anything else the guest needs in its filesystem — firmware blobs and the
   * like. None of the current boards need any.
   */
  extraFiles?: Array<{ fsPath: string; asset: string }>
  /**
   * Whether this board needs a file_packager bundle (`load.js` + `.data`).
   * Unnecessary for a bare ELF, which is fetched and injected directly.
   */
  usesDataBundle: boolean
}

/*
 * Sleeping is mostly fine, but a couple of multi-threaded samples hang:
 * Philosophers and Synchronization were both shipped here and both stall under
 * qemu-wasm, though they run correctly on native QEMU (including 10.0.50, the
 * version ktock's fork is based on). Single-threaded sleepers are unaffected:
 * blinky (a k_msleep loop) and basic_button (a polled gpio-keys work item) run
 * steadily — only the wall clock is off, the interpreter runs the 1 Hz blink
 * several times faster than real time.
 *
 * The cause is ktock's TCG→Wasm JIT miscompiling something, not the guest and
 * not the SysTick device: forcing everything to stay interpreted takes
 * Synchronization from 1 line to 14, deterministically. It still stalls, so
 * there is a further defect too.
 *
 * Note the "Timer with period zero, disabling" line on every boot is *not* the
 * cause, however much it looks like it — native QEMU prints it too on runs that
 * work. See public/qemu/README.md for the full trace.
 */
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
    // The shell is the interface to the host bridges it advertises. This board
    // has no I2C bus, so no simulated sensors — the sensor cards are A53-only.
    primaryPanels: ['gpio', 'audio'],
  },
  {
    // Event-driven end to end (shell in, logs out), so it dodges the TCI
    // k_sleep stall that keeps most samples off this board.
    id: 'hsm',
    label: 'State Machine',
    description: 'Hierarchical state machine driven from the shell',
    zephyrSample: 'samples/subsys/smf/hsm_psicc2',
  },
  {
    // main() returns after kicking DHCP off; progress rides the RX interrupt
    // chain, so it dodges the TCI k_sleep stall.
    id: 'dhcp',
    label: 'DHCP Client',
    description: 'Acquires an IPv4 lease from the browser network',
    zephyrSample: 'samples/net/dhcpv4_client',
    primaryPanels: ['net'],
  },
  {
    // Steady state blocks in accept()/recv(), woken by injected frames.
    id: 'http_server',
    label: 'HTTP Server',
    description: 'Serves a page at 192.0.2.1:8080 — fetch it from the Network panel',
    zephyrSample: 'samples/net/sockets/dumb_http_server',
    primaryPanels: ['net'],
  },
  {
    // Run-to-completion: one DNS lookup, one GET, prints, exits.
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
    // led0 is the host-gpio bridge's pin 4 (LED0 in the panel), so the blink
    // shows up as the panel's LED0 flashing once a second.
    id: 'blinky',
    label: 'Blinky',
    description: 'Blinks LED0 on the host GPIO bridge',
    zephyrSample: 'samples/basic/blinky',
    primaryPanels: ['led', 'gpio'],
  },
  {
    // gpio-buzzer on host_gpio pin 5; LED0 stays on pin 4. Frequency args are
    // on/off only for the GPIO backend — the dock shakes + vibrates/buzzes.
    id: 'buzzer',
    label: 'Buzzer',
    description: 'Drives a gpio-buzzer; the dock shakes and vibrates',
    zephyrSample: 'samples/drivers/buzzer/tone',
    primaryPanels: ['buzzer', 'gpio', 'led'],
  },
  {
    // A polled gpio-keys button (SW0, pin 0) drives the input subsystem, which
    // lights led0 (pin 4) — click SW0 in the GPIO panel to press it.
    id: 'basic_button',
    label: 'Button',
    description: 'A host GPIO button lights an LED via the input subsystem',
    zephyrSample: 'samples/basic/button',
    primaryPanels: ['gpio', 'led'],
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
    // Fork under zephyr-module/apps: circular update + smaller ramfb so the
    // emulated A53 can keep the trace moving in wall-clock time.
    zephyrSample: 'zephyr-module/apps/accelerometer_chart',
    // The accelerometer feeds the chart, so surface both input and output.
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
    // Boot counter through Zephyr's EEPROM API against the AT24 at 0x50. The
    // page keeps the chip's bytes in localStorage, so a reload ("MCU reset")
    // increments the count; the Memory card's erase button clears it.
    id: 'eeprom',
    label: 'EEPROM',
    description: 'Boot counter that survives reloads in the simulated AT24',
    zephyrSample: 'samples/drivers/eeprom',
    primaryPanels: ['i2c'],
  },
  {
    // Stock RTC sample against the browser PCF8523 at 0x68. The dock RTC card
    // shows the same clock; the shell sample adds set_alarm under CONFIG_RTC_ALARM.
    id: 'rtc',
    label: 'RTC',
    description: 'Set and read date/time on a PCF8523, over I²C',
    zephyrSample: 'samples/drivers/rtc',
    primaryPanels: ['i2c'],
  },
  {
    // Character LCD via Zephyr's auxdisplay API against the Grove JHD1313
    // (LCD @0x3e + RGB backlight @0x62) modelled in the page.
    id: 'auxdisplay',
    label: 'Aux display',
    description: '“Hello World” on a 16×2 I²C character LCD (JHD1313) in the page',
    zephyrSample: 'samples/drivers/auxdisplay',
    primaryPanels: ['auxdisplay', 'i2c'],
  },
  {
    // Stock LED sample against the browser HT16K33 at 0x70. The dock paints
    // the 16×8 display RAM; keyscan is off in this packaging.
    id: 'ht16k33',
    label: 'HT16K33 LED',
    description: 'Walks, blinks and dims a 16×8 I²C LED matrix (HT16K33) in the page',
    zephyrSample: 'samples/drivers/ht16k33',
    primaryPanels: ['led', 'i2c'],
  },
  {
    // PWM LEDs via Zephyr's led_pwm against the browser PCA9685 at 0x60.
    // Dock shows the pwm-leds brightness strip and the PWM duty chart.
    id: 'pwm_led',
    label: 'PWM LED',
    description: 'Fades and blinks PWM LEDs on a PCA9685; LEDs + duty chart in the page',
    zephyrSample: 'samples/drivers/led/pwm',
    primaryPanels: ['led', 'pwm', 'i2c'],
  },
  {
    // Stock DAC sample against the browser MCP4725 at 0x61. The dock paints
    // a Vout history chart (DacChip framework).
    id: 'dac',
    label: 'DAC',
    description: 'Sawtooth on a 12-bit MCP4725; Vout chart in the page',
    zephyrSample: 'samples/drivers/dac',
    primaryPanels: ['dac', 'i2c'],
  },
  {
    // Stock fuel-gauge sample against the browser MAX17048 at 0x36. The dock
    // paints SoC % / voltage (FuelGaugeChip framework).
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
    // Stock CTF + semihosting sample: writes tracing.bin into the emulator FS;
    // the Trace stage panel follows it live (docs/tracing-feasibility.md).
    id: 'tracing',
    label: 'Tracing',
    description: 'Live CTF schedule view — thread lanes like Zephyr’s trace_viewer',
    zephyrSample: 'samples/subsys/tracing/basic',
    primaryPanels: ['trace'],
  },
  {
    // Same sample and same panel as the Cortex-M3 blinky, but led0 is pin 4 of
    // a standard VIRTIO GPIO device rather than a bespoke register block.
    id: 'blinky',
    label: 'Blinky',
    description: 'Blinks LED0 over a VIRTIO GPIO device',
    zephyrSample: 'samples/basic/blinky',
    primaryPanels: ['led', 'gpio'],
  },
  {
    // gpio-buzzer on virtio_gpio0 pin 5 (LED0 stays on 4). Same dock body as
    // the M3 build — observe the GPIO output; no new QEMU device.
    id: 'buzzer',
    label: 'Buzzer',
    description: 'Drives a gpio-buzzer over VIRTIO GPIO; the dock shakes and vibrates',
    zephyrSample: 'samples/drivers/buzzer/tone',
    primaryPanels: ['buzzer', 'gpio', 'led'],
  },
  {
    // Interrupt-driven, unlike the Cortex-M3 build: this device offers
    // VIRTIO_GPIO_F_IRQ, so gpio-keys arms an event virtqueue buffer instead
    // of polling the pin.
    id: 'basic_button',
    label: 'Button',
    description: 'A browser button lights an LED, over an interrupt-driven VIRTIO GPIO',
    zephyrSample: 'samples/basic/button',
    primaryPanels: ['gpio', 'led'],
  },
  {
    id: 'shell',
    label: 'Shell',
    description: 'Interactive Zephyr shell, with `i2c`, `sensor`, `rtc`, `hostaudio` and `dmic`',
    zephyrSample: 'samples/subsys/shell/shell_module',
    primaryPanels: ['i2c', 'audio'],
  },
  {
    // The display sample against the browser's SSD1306 instead of ramfb: the
    // stock solomon,ssd1306 driver pushing pixels over I2C into GDDRAM that
    // lives in the page. No framebuffer anywhere in the path.
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
      // Pair the machine's stellaris_enet with the browser netdev; the page
      // implements the network (src/net/). Only `-nic` can attach a backend
      // to a sysbus NIC.
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
    // The shell is the one worth landing on: it is interactive, and it is where
    // the host-sensor bridge is visible.
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
      '-icount',
      'shift=4,align=off,sleep=on',
      '-rtc',
      'clock=vm',
      // ARM semihosting: Zephyr's CTF tracing backend appends to ./tracing.bin
      // in the Emscripten FS; hostTrace.ts polls it for the Trace panel. Harmless
      // when the guest never opens a semihost file.
      '-semihosting',
      // Zephyr's virtio-mmio driver only speaks modern (v2) transports.
      '-global',
      'virtio-mmio.force-legacy=false',
      // Ethernet: virtio-net on the first virtio-mmio slot, backed by the
      // browser netdev (the page implements the LAN — src/net/). The MAC
      // must match the shield overlay's local-mac-address: QEMU filters
      // inbound unicast against it and the guest driver never programs it.
      '-netdev',
      'browser,id=n0',
      '-device',
      'virtio-net-device,netdev=n0,bus=virtio-mmio-bus.0,mac=02:00:00:00:00:01',
      // Pointer input: a stock virtio tablet on the slot the board devicetree
      // reserves for it (0x0a000600, SPI 19), driven by Zephyr's upstream
      // virtio,input driver. Unlike every other bridge here there is no QEMU
      // device of ours — only a frontend feeding QEMU's input core, since the
      // wasm build has no SDL/GTK/VNC to do it. Slot 3 and not 2 because
      // Zephyr's own board.cmake picks 3, so a native `west build -t run`
      // reproduces the browser's wiring exactly.
      '-device',
      'virtio-tablet-device,bus=virtio-mmio-bus.3',
      // GPIO: a standard VIRTIO GPIO device on the slot the shield overlay
      // reserves for it (0x0a000400, SPI 18), driven by the vendored
      // virtio,gpio driver. QEMU has no virtio-gpio device model of its own,
      // and now neither do we: this is the *generic* bridge, and the device
      // model is src/virtio/devices/gpio.ts. `name=gpio` is what binds the two.
      //
      // device-id 41 is VIRTIO_ID_GPIO; two queues are the request and event
      // queues; feature bit 0 is VIRTIO_GPIO_F_IRQ, without which the guest
      // driver polls instead of taking interrupts. `config` is the device's
      // config space as hex — struct virtio_gpio_config { le16 ngpio; u8
      // padding[2]; le32 gpio_names_size; } — so 8 lines and no names. It is a
      // property rather than something the page supplies because the guest can
      // read config space before the page has attached. ngpio must match the
      // overlay's ngpios.
      '-device',
      'virtio-browser-device,bus=virtio-mmio-bus.2,name=gpio,device-id=41,' +
        'queues=2,features=0x1,config=0800000000000000',
      // I2C: a VIRTIO I2C adapter (device id 34) on slot 4, the first free one
      // after net, gpu, gpio and the tablet. One request queue, no feature bits
      // and no config space — the adapter has none. The chips on the bus are
      // page-side models (src/virtio/devices/chips/), so adding one is a
      // TypeScript file rather than an emulator rebuild.
      '-device',
      'virtio-browser-device,bus=virtio-mmio-bus.4,name=i2c,device-id=34,queues=1',
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
      // The only board started with -icount, so the only one whose guest
      // instruction counter advances.
      perfStats: true,
      hostNet: true,
      virtio: true,
      // Semihosting CTF follow — pairs with -semihosting above.
      hostTrace: true,
    },
    samples: CORTEX_A53_SAMPLES,
    defaultSampleId: 'display',
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
      // Matches Zephyr boards/qemu/riscv32/board.cmake + qemu_riscv32_defconfig
      // (CONFIG_RISCV_PMP=y → pmp=on,u=on).
      '-cpu',
      'rv32i,i=on,m=on,a=on,f=on,d=on,c=on,zicsr=on,zifencei=on,pmp=on,u=on',
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
      // No -icount / guest-icount export on the TCI riscv32 build yet.
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

export const DEFAULT_BOARD_ID = BOARDS[0].id

export function getBoard(id: string): Board {
  return BOARDS.find((b) => b.id === id) ?? BOARDS[0]
}

export function getSample(board: Board, sampleId: string): GuestSample {
  return board.samples.find((s) => s.id === sampleId) ?? board.samples[0]
}

/** Panels a sample wants expanded on boot; empty when it is terminal-only. */
export function samplePrimaryPanels(board: Board, sampleId: string): Set<PanelKind> {
  return new Set(getSample(board, sampleId).primaryPanels)
}

/** Where a board's prebuilt image lives under public/qemu/. */
export function sampleAsset(board: Board, sampleId: string): string {
  return `zephyr/${board.zephyrTarget}/${sampleId}.elf`
}

/**
 * The flattened devicetree shipped next to the image, when the build put one
 * there (tools/build-zephyr-image.sh does; older tarballs may not have it).
 */
export function sampleDtsAsset(board: Board, sampleId: string): string {
  return `zephyr/${board.zephyrTarget}/${sampleId}.dts`
}
