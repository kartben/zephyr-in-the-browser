/**
 * One device inventory, two projections. The dock renders the same rows either
 * nested the way the devicetree nests them (the ⌗ view) or grouped by
 * peripheral class (the ▤ view); this module derives that inventory as pure
 * data — no React, no stores, no subscriptions.
 *
 * The parsed devicetree of the running build is the preferred source, the same
 * doctrine registry.ts and hostGpio.ts follow: when a zephyr.dts is loaded, its
 * nodes decide what exists and what everything is called — including buses this
 * page does not bridge, which are listed inert rather than hidden. Only when no
 * tree is known does a per-board static table reproduce the historical picture.
 *
 * Availability still gates what is *interactive*: a devicetree can promise a
 * bridge the runtime has not exposed (mock backend, early boot), and those rows
 * simply do not appear yet — the same progressive fill the panels always had.
 */

import type { PanelKind } from '@/boards'
import type { DeviceTreeState } from '@/devicetree'
import type { DtsDocument, DtsInsights, DtsNode, I2cSlot, SpiSlot } from '@/dts'
import { byPath, compatibles, isEffectivelyOkay, nodesByCompatible, pathOf, regAddress } from '@/dts'
import type { I2cChip } from '@/virtio/devices/i2c'
import type { SpiChip } from '@/virtio/devices/spi'
import type { ChipKind } from '@/virtio/devices/registry'
import { FALLBACK_DT_SLOTS, CHIP_TYPES, chipType } from '@/virtio/devices/registry'
import { partCompatible } from '@/virtio/devices/parts'
import { isHt16k33 } from '@/virtio/devices/chips/ht16k33'
import { isLp5562 } from '@/virtio/devices/chips/lp5562'
import { isLp50xx } from '@/virtio/devices/chips/lp50xx'
import { isSct2024 } from '@/virtio/devices/chips/sct2024'
import { isWs2812 } from '@/virtio/devices/chips/ws2812'
import { isPt6314 } from '@/virtio/devices/chips/pt6314'
import { isTmc50xx } from '@/virtio/devices/chips/tmc50xx'
import { isSpiFlashChip } from '@/virtio/devices/chips/w25q'
import { isMcp2515 } from '@/virtio/devices/chips/mcp2515'
import { isJhd1313Backlight, isJhd1313Lcd } from '@/virtio/devices/chips/jhd1313'
import { isMemoryChip } from '@/virtio/devices/memory/model'
import { isDacChip } from '@/virtio/devices/dac/model'
import { isFuelGaugeChip } from '@/virtio/devices/fuel-gauge/model'
import { isPwmChip } from '@/virtio/devices/pwm/model'
import { isRtcChip } from '@/virtio/devices/rtc/model'
import { isSensorChip } from '@/virtio/devices/sensors/model'

export type DockView = 'devicetree' | 'classes'

/** Grouping key of the ▤ view. Friendly labels only (CLASS_LABELS). */
export type DeviceClass =
  | 'sensor'
  | 'display'
  | 'auxdisplay'
  | 'led'
  | 'pwm'
  | 'dac'
  | 'fuel-gauge'
  | 'memory'
  | 'rtc'
  | 'i2c-bus'
  | 'spi-bus'
  | 'uart-bus'
  | 'can-bus'
  | 'gpio'
  | 'keys'
  | 'buzzer'
  | 'stepper'
  | 'gnss'
  | 'audio'
  | 'net'
  | 'other'

/** Which extracted panel body a row hosts (see components/dock/deviceBodies). */
export type BodyKind =
  | 'sensor'
  | 'memory'
  | 'oled'
  | 'auxdisplay'
  | 'seven-seg'
  | 'led'
  | 'rgb-led'
  | 'led-bar'
  | 'pwm-leds'
  | 'gpio-leds'
  | 'pwm'
  | 'dac'
  | 'fuel-gauge'
  | 'rtc'
  | 'i2c'
  | 'spi'
  | 'uart'
  | 'can'
  | 'spi-flash'
  | 'gpio'
  | 'gpio-keys'
  | 'buzzer'
  | 'stepper'
  | 'stepper-tmc'
  | 'gnss'
  | 'speaker'
  | 'mic'
  | 'net'

/** Which runtime bridges are actually live right now. */
export interface Availability {
  gnss: boolean
  gpio: boolean
  audio: boolean
  mic: boolean
  net: boolean
  i2c: boolean
  spi: boolean
  display: boolean
  input: boolean
}

export interface DeviceNode {
  /** Stable identity: expansion, visibility and float geometry key off this. */
  key: string
  /** Devicetree-flavoured primary name for the ⌗ view (`tmp112@48`). */
  nodeName: string
  /** Friendly primary name for the ▤ view ('TMP112 temperature'). */
  label: string
  compatible?: string
  deviceClass: DeviceClass
  /** Devicetree path, used for ⌗ ordering and nesting. */
  path: string
  /** Key of the row this one nests under in the ⌗ view (bus, UART, …). */
  parentKey?: string
  /**
   * interactive: has live controls. inert: listed for topology completeness
   * (console UART bus, an unbridged bus). ghost: the devicetree declares it but
   * nothing answers on the bus — the NAK/bus-error demo, visible.
   */
  presence: 'interactive' | 'inert' | 'ghost'
  /** Short annotation ('→ terminal', 'on stage', 'NAK — detached'). */
  note?: string
  /** Small qualifier chip ('bus only' for an attached-but-undeclared part). */
  tag?: string
  body?: BodyKind
  /** ▤-view breadcrumb locating the row on the hardware ('virtio_i2c0 · 0x48'). */
  crumb?: string
  /** Live chip handle, for sensor/memory/oled/spi-flash bodies. */
  chip?: I2cChip | SpiChip
  /**
   * Catalog / attach-picker id when known (`tmp112`, `w25q`, …). Drives the
   * datasheet identity strip on live chip bodies.
   */
  partId?: string
  /**
   * Children of a `pwm-leds` group when `body` is `pwm-leds` — channel index
   * and DT label, brightness read from {@link chip}'s PwmChip channels.
   */
  pwmLeds?: Array<{ channel: number; label: string }>
  /** Controller label scoping an 'i2c'/'spi'/'uart' body's roster/traffic. */
  busLabel?: string
  /** The legacy panel kind whose expand-on-boot rule this row inherits. */
  panelKind?: PanelKind
}

export interface DeviceInventory {
  nodes: DeviceNode[]
  source: 'devicetree' | 'fallback'
  /** Root `model` string, shown on the ⌗ view's root row. */
  rootName?: string
  /** The .dts file name, when a tree is loaded. */
  treeName?: string
}

export type Row =
  | { kind: 'device'; node: DeviceNode; depth: number }
  /** ⌗-view structural scaffolding: the root and shared ancestors like `soc`. */
  | { kind: 'struct'; key: string; name: string; depth: number; note?: string }
  /** ▤-view group header. */
  | { kind: 'group'; key: string; deviceClass: DeviceClass; label: string; count: number }

export const CLASS_LABELS: Record<DeviceClass, string> = {
  sensor: 'Sensors',
  display: 'Displays',
  auxdisplay: 'Aux displays',
  led: 'LEDs',
  pwm: 'PWM',
  dac: 'DAC',
  'fuel-gauge': 'Fuel gauge',
  memory: 'Memory',
  rtc: 'RTC',
  'i2c-bus': 'I²C buses',
  'spi-bus': 'SPI buses',
  'uart-bus': 'UART buses',
  'can-bus': 'CAN',
  gpio: 'GPIO',
  keys: 'Keys',
  buzzer: 'Buzzer',
  stepper: 'Stepper',
  gnss: 'GNSS',
  audio: 'Audio',
  net: 'Network',
  other: 'Other devices',
}

const CLASS_ORDER: DeviceClass[] = [
  'sensor',
  'display',
  'auxdisplay',
  'led',
  'pwm',
  'dac',
  'fuel-gauge',
  'memory',
  'rtc',
  'i2c-bus',
  'spi-bus',
  'uart-bus',
  'can-bus',
  'gpio',
  'keys',
  'buzzer',
  'stepper',
  'gnss',
  'audio',
  'net',
  'other',
]

const KIND_TO_CLASS: Record<ChipKind, DeviceClass> = {
  sensor: 'sensor',
  eeprom: 'memory',
  display: 'display',
  auxdisplay: 'auxdisplay',
  led: 'led',
  pwm: 'pwm',
  dac: 'dac',
  'fuel-gauge': 'fuel-gauge',
  rtc: 'rtc',
}

function hex(address: number): string {
  return address.toString(16).padStart(2, '0')
}

/** Duck-typed, like PeripheralPanels always did; the SSD1306 has no decl. */
function chipClass(chip: I2cChip): DeviceClass {
  if (isSensorChip(chip)) return 'sensor'
  if (isMemoryChip(chip)) return 'memory'
  if (isRtcChip(chip)) return 'rtc'
  if (isJhd1313Lcd(chip) || isJhd1313Backlight(chip)) return 'auxdisplay'
  if (isHt16k33(chip)) return 'led'
  if (isLp5562(chip) || isLp50xx(chip)) return 'led'
  if (isPwmChip(chip)) return 'pwm'
  if (isDacChip(chip)) return 'dac'
  if (isFuelGaugeChip(chip)) return 'fuel-gauge'
  if ('isOn' in chip && 'memory' in chip) return 'display'
  return 'other'
}

function chipBody(cls: DeviceClass, chip?: I2cChip): BodyKind | undefined {
  if (cls === 'sensor') return 'sensor'
  if (cls === 'memory') return 'memory'
  if (cls === 'display') return 'oled'
  if (cls === 'auxdisplay') {
    // Backlight is edited from the LCD card's Registers affordance; no own body.
    if (chip && isJhd1313Backlight(chip)) return undefined
    return 'auxdisplay'
  }
  if (cls === 'led') {
    if (chip && (isLp5562(chip) || isLp50xx(chip))) return 'rgb-led'
    return 'led'
  }
  if (cls === 'pwm') return 'pwm'
  if (cls === 'dac') return 'dac'
  if (cls === 'fuel-gauge') return 'fuel-gauge'
  if (cls === 'rtc') return 'rtc'
  return undefined
}

/** Which legacy PanelKind's expand-on-boot rule a chip row inherits. */
function chipPanelKind(cls: DeviceClass): PanelKind | undefined {
  if (cls === 'sensor') return 'sensor'
  if (cls === 'memory') return 'i2c'
  if (cls === 'display') return 'oled'
  if (cls === 'auxdisplay') return 'auxdisplay'
  if (cls === 'led') return 'led'
  if (cls === 'pwm') return 'pwm'
  if (cls === 'dac') return 'dac'
  if (cls === 'fuel-gauge') return 'fuel-gauge'
  if (cls === 'rtc') return 'i2c'
  return undefined
}

/** A DT-ish node name for a chip the tree does not declare (`tmp112@60`). */
function synthChipNodeName(chip: I2cChip): string {
  const stem = (chip.name.split(/[\s(]/)[0] || 'i2c-dev').toLowerCase()
  return `${stem}@${hex(chip.address)}`
}

/** Prefer DT chipId; otherwise match the attach-picker label to the live name. */
function inferI2cPartId(chip: I2cChip, slot?: I2cSlot): string | undefined {
  if (slot?.chipId) return slot.chipId
  if (isJhd1313Lcd(chip)) return 'jhd1313'
  return CHIP_TYPES.find((t) => t.label === chip.name)?.id
}

interface Ids {
  used: Set<string>
}

function uniqueKey(ids: Ids, base: string): string {
  let key = base
  for (let n = 2; ids.used.has(key); n++) key = `${base}~${n}`
  ids.used.add(key)
  return key
}

/**
 * The chip rows under one live (bridged, bound) bus: every attached chip in
 * address order, interleaved with ghost rows for declared-but-unanswered slots.
 */
function liveBusChildren(
  ids: Ids,
  busKey: string,
  busLabel: string,
  busPath: string,
  slots: readonly I2cSlot[],
  chips: readonly I2cChip[],
): DeviceNode[] {
  const slotByAddr = new Map(slots.map((slot) => [slot.address, slot]))
  const chipByAddr = new Map(chips.map((chip) => [chip.address, chip]))
  const addresses = [...new Set([...slotByAddr.keys(), ...chipByAddr.keys()])].sort((a, b) => a - b)

  const rows: DeviceNode[] = []
  for (const address of addresses) {
    const slot = slotByAddr.get(address)
    const chip = chipByAddr.get(address)
    const crumb = `${busLabel} · 0x${hex(address)}`

    if (chip) {
      // Backlight is a side-channel address on the JHD1313 module (DT property
      // backlight-addr), not its own child node — the LCD card owns its UI.
      if (isJhd1313Backlight(chip)) continue
      const cls = chipClass(chip)
      const partId = inferI2cPartId(chip, slot)
      rows.push({
        key: uniqueKey(ids, `${busLabel}:${hex(address)}`),
        nodeName: slot?.nodeName ?? synthChipNodeName(chip),
        label: chip.name,
        compatible: slot?.compatible || (partId ? partCompatible(partId) : undefined),
        deviceClass: cls,
        path: `${busPath}/${slot?.nodeName ?? synthChipNodeName(chip)}`,
        parentKey: busKey,
        presence: 'interactive',
        tag: slot ? undefined : 'bus only',
        body: chipBody(cls, chip),
        crumb,
        chip,
        partId,
        busLabel,
        panelKind: chipPanelKind(cls),
      })
      continue
    }

    // Declared in the tree, answered by nothing: the driver NAKs exactly like
    // the part fell off the board. Worth a row, not an omission.
    const declared = slot!
    const type = declared.chipId ? chipType(declared.chipId) : undefined
    rows.push({
      key: uniqueKey(ids, `${busLabel}:${hex(address)}`),
      nodeName: declared.nodeName,
      label: type?.label ?? declared.compatible ?? declared.nodeName,
      compatible: declared.compatible || undefined,
      deviceClass: type ? KIND_TO_CLASS[type.kind] : 'i2c-bus',
      path: `${busPath}/${declared.nodeName}`,
      parentKey: busKey,
      presence: 'ghost',
      note: 'NAK — detached',
      crumb,
      partId: declared.chipId,
      busLabel,
    })
  }
  return rows
}

function liveSpiBusChildren(
  ids: Ids,
  busKey: string,
  busLabel: string,
  busPath: string,
  slots: readonly SpiSlot[],
  chips: readonly SpiChip[],
): DeviceNode[] {
  const slotByCs = new Map(slots.map((slot) => [slot.cs, slot]))
  const chipByCs = new Map(chips.map((chip) => [chip.cs, chip]))
  const selects = [...new Set([...slotByCs.keys(), ...chipByCs.keys()])].sort((a, b) => a - b)

  const rows: DeviceNode[] = []
  for (const cs of selects) {
    const slot = slotByCs.get(cs)
    const chip = chipByCs.get(cs)
    const crumb = `${busLabel} · CS${cs}`
    const keyCs = cs.toString(16)

    if (chip) {
      const flash = isSpiFlashChip(chip)
      const ledBar = isSct2024(chip)
      const ledStrip = isWs2812(chip)
      const vfd = isPt6314(chip)
      const stepper = isTmc50xx(chip)
      const can = isMcp2515(chip)
      const partId =
        slot?.chipId ??
        (flash
          ? 'w25q'
          : ledBar
            ? 'sct2024'
            : ledStrip
              ? 'ws2812'
              : vfd
                ? 'pt6314'
                : stepper
                  ? 'tmc50xx'
                  : can
                    ? 'mcp2515'
                    : undefined)
      rows.push({
        key: uniqueKey(ids, `${busLabel}:${keyCs}`),
        nodeName: slot?.nodeName ?? `spi-dev@${cs}`,
        label: chip.name,
        compatible: slot?.compatible || (partId ? partCompatible(partId) : undefined),
        deviceClass: flash
          ? 'memory'
          : ledBar || ledStrip
            ? 'led'
            : vfd
              ? 'auxdisplay'
              : stepper
                ? 'stepper'
                : can
                  ? 'can-bus'
                  : 'other',
        path: `${busPath}/${slot?.nodeName ?? `spi-dev@${cs}`}`,
        parentKey: busKey,
        presence: 'interactive',
        tag: slot ? undefined : 'bus only',
        body: flash
          ? 'spi-flash'
          : ledBar
            ? 'led-bar'
            : ledStrip
              ? 'rgb-led'
              : vfd
                ? 'auxdisplay'
                : stepper
                  ? 'stepper-tmc'
                  : can
                    ? 'can'
                    : undefined,
        crumb,
        chip,
        partId,
        busLabel,
        panelKind: flash
          ? 'spi'
          : ledBar || ledStrip
            ? 'led'
            : vfd
              ? 'auxdisplay'
              : stepper
                ? 'stepper'
                : can
                  ? 'can'
                  : undefined,
      })
      continue
    }

    const declared = slot!
    rows.push({
      key: uniqueKey(ids, `${busLabel}:${keyCs}`),
      nodeName: declared.nodeName,
      label: declared.compatible || declared.nodeName,
      compatible: declared.compatible || undefined,
      deviceClass:
        declared.chipId === 'w25q'
          ? 'memory'
          : declared.chipId === 'sct2024' || declared.chipId === 'ws2812'
            ? 'led'
            : declared.chipId === 'pt6314'
              ? 'auxdisplay'
              : declared.chipId === 'tmc50xx'
                ? 'stepper'
                : 'spi-bus',
      path: `${busPath}/${declared.nodeName}`,
      parentKey: busKey,
      presence: 'ghost',
      note: 'ERR — detached',
      crumb,
      partId: declared.chipId,
      busLabel,
    })
  }
  return rows
}

function deriveFromTree(
  doc: DtsDocument,
  insights: DtsInsights,
  chips: readonly I2cChip[],
  spiChips: readonly SpiChip[],
  avail: Availability,
): DeviceNode[] {
  const ids: Ids = { used: new Set() }
  const nodes: DeviceNode[] = []
  const byDtPath = new Map<string, DeviceNode>()

  const push = (node: DeviceNode) => {
    nodes.push(node)
    byDtPath.set(node.path, node)
    return node
  }

  const firstOkay = (...compats: string[]): DtsNode | undefined => {
    for (const compat of compats) {
      const node = nodesByCompatible(doc, compat).find(isEffectivelyOkay)
      if (node) return node
    }
    return undefined
  }

  if (avail.audio) {
    const speaker = firstOkay('qemu,host-audio')
    if (speaker) {
      push({
        key: uniqueKey(ids, 'audio'),
        nodeName: speaker.name,
        label: 'Speaker',
        compatible: compatibles(speaker)[0],
        deviceClass: 'audio',
        path: pathOf(speaker),
        presence: 'interactive',
        body: 'speaker',
        crumb: speaker.labels[0],
        panelKind: 'audio',
      })
    }
  }
  if (avail.mic) {
    const mic = firstOkay('qemu,host-mic')
    if (mic) {
      push({
        key: uniqueKey(ids, 'mic'),
        nodeName: mic.name,
        label: 'Microphone',
        compatible: compatibles(mic)[0],
        deviceClass: 'audio',
        path: pathOf(mic),
        presence: 'interactive',
        body: 'mic',
        crumb: mic.labels[0],
        panelKind: 'audio',
      })
    }
  }

  if (avail.net) {
    const nic = firstOkay('virtio,net', 'ti,stellaris-ethernet')
    if (nic) {
      push({
        key: uniqueKey(ids, 'net'),
        nodeName: nic.name,
        label: 'Network',
        compatible: compatibles(nic)[0],
        deviceClass: 'net',
        path: pathOf(nic),
        presence: 'interactive',
        body: 'net',
        crumb: nic.labels[0],
        panelKind: 'net',
      })
    }
  }

  if (avail.display) {
    const display = firstOkay('qemu,ramfb', 'virtio,gpu')
    if (display) {
      push({
        key: uniqueKey(ids, 'display'),
        nodeName: display.name,
        label: 'Display',
        compatible: compatibles(display)[0],
        deviceClass: 'display',
        path: pathOf(display),
        presence: 'inert',
        note: 'on stage',
        crumb: display.labels[0],
      })
    }
  }

  if (avail.input) {
    const tablet = firstOkay('virtio,input')
    if (tablet) {
      push({
        key: uniqueKey(ids, 'input'),
        nodeName: tablet.name,
        label: 'Touch input',
        compatible: compatibles(tablet)[0],
        deviceClass: 'other',
        path: pathOf(tablet),
        presence: 'inert',
        note: '→ display touch',
        crumb: tablet.labels[0],
      })
    }
  }

  // GPIO controllers: the bridged one drives the panel; the rest of the tree's
  // controllers are still listed, inert — a user-dropped board file has them.
  let gpioBodyUsed = false
  for (const ctl of insights.gpioControllers) {
    const live = ctl.bridged && avail.gpio && !gpioBodyUsed
    if (ctl.bridged && !avail.gpio) continue
    if (live) gpioBodyUsed = true
    const pathParts = ctl.path.split('/').filter(Boolean)
    const nodeName = pathParts[pathParts.length - 1] ?? ctl.controllerLabel
    push({
      key: uniqueKey(ids, live ? 'gpio' : `gpio:${ctl.controllerLabel}`),
      nodeName,
      label: live ? 'GPIO' : ctl.controllerLabel,
      compatible: ctl.compatible || undefined,
      deviceClass: 'gpio',
      path: ctl.path,
      presence: live ? 'interactive' : 'inert',
      note: live ? undefined : 'no page model',
      body: live ? 'gpio' : undefined,
      crumb: ctl.controllerLabel,
      panelKind: live ? 'gpio' : undefined,
    })
  }

  // gpio-keys: Keys-class row — buttons leave the GPIO controller card.
  const bridgedKeys = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.buttons.length > 0,
  )
  if (bridgedKeys && avail.gpio) {
    const keysNode = nodesByCompatible(doc, 'gpio-keys').find(isEffectivelyOkay)
    push({
      key: uniqueKey(ids, 'gpio-keys'),
      nodeName: keysNode?.name ?? 'keys',
      label: 'GPIO Keys',
      compatible: 'gpio-keys',
      deviceClass: 'keys',
      path: keysNode ? pathOf(keysNode) : '/keys',
      presence: 'interactive',
      body: 'gpio-keys',
      crumb: bridgedKeys.controllerLabel,
      panelKind: 'keys',
    })
  }

  // gpio-leds groups: LED-class row, like pwm-leds / gpio-buzzer — not folded
  // into the GPIO button grid.
  const bridgedLeds = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.leds.length > 0,
  )
  if (bridgedLeds && avail.gpio) {
    const ledsNode = nodesByCompatible(doc, 'gpio-leds').find(isEffectivelyOkay)
    push({
      key: uniqueKey(ids, 'gpio-leds'),
      nodeName: ledsNode?.name ?? 'leds',
      label: 'GPIO LEDs',
      compatible: 'gpio-leds',
      deviceClass: 'led',
      path: ledsNode ? pathOf(ledsNode) : '/leds',
      presence: 'interactive',
      body: 'gpio-leds',
      crumb: bridgedLeds.controllerLabel,
      panelKind: 'led',
    })
  }

  // gpio-7-segment: multiplexed LED digits — own auxdisplay row (not a bus chip).
  const bridgedSeven = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.sevenSegs.length > 0,
  )
  if (bridgedSeven && avail.gpio) {
    for (const disp of bridgedSeven.sevenSegs) {
      const node = nodesByCompatible(doc, 'gpio-7-segment').find(
        (n) => isEffectivelyOkay(n) && pathOf(n) === disp.id,
      )
      push({
        key: uniqueKey(ids, 'seven-seg'),
        nodeName: node?.name ?? 'digi-display',
        label: disp.label,
        compatible: 'gpio-7-segment',
        deviceClass: 'auxdisplay',
        path: disp.id,
        presence: 'interactive',
        body: 'seven-seg',
        crumb: `${disp.digits.length}-digit · ${bridgedSeven.controllerLabel}`,
        panelKind: 'auxdisplay',
      })
    }
  }

  // gpio-buzzer leaves: one dock body for every buzzers on the bridged controller.
  // Not folded into the GPIO grid — shake / vibrate deserves its own row.
  const bridgedBuzz = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.buzzers.length > 0,
  )
  if (bridgedBuzz && avail.gpio) {
    const buzzerNode = nodesByCompatible(doc, 'gpio-buzzer').find(isEffectivelyOkay)
    const first = bridgedBuzz.buzzers[0]
    push({
      key: uniqueKey(ids, 'buzzer'),
      nodeName: buzzerNode?.name ?? 'buzzer',
      label: first?.label ?? 'Buzzer',
      compatible: 'gpio-buzzer',
      deviceClass: 'buzzer',
      path: buzzerNode ? pathOf(buzzerNode) : '/buzzer',
      presence: 'interactive',
      body: 'buzzer',
      crumb: `pin ${first?.id}`,
      panelKind: 'buzzer',
    })
  }

  // gpio step/dir steppers: observe STEP/DIR edges like buzzer observes level.
  const bridgedStep = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.steppers.length > 0,
  )
  if (bridgedStep && avail.gpio) {
    const stepperNode = nodesByCompatible(doc, 'zephyr,gpio-step-dir-stepper-ctrl').find(
      isEffectivelyOkay,
    )
    const first = bridgedStep.steppers[0]
    push({
      key: uniqueKey(ids, 'stepper'),
      nodeName: stepperNode?.name ?? 'stepper',
      label: first?.label ?? 'Stepper',
      compatible: 'zephyr,gpio-step-dir-stepper-ctrl',
      deviceClass: 'stepper',
      path: stepperNode ? pathOf(stepperNode) : first?.id ?? '/stepper',
      presence: 'interactive',
      body: 'stepper',
      crumb: first ? `STEP ${first.stepPin} · DIR ${first.dirPin}` : undefined,
      panelKind: 'stepper',
    })
  }

  // pwm-leds groups: brightness strip driven by an attached PwmChip. Sibling of
  // the PWM controller row — see docs/pwm-leds.md.
  if (avail.i2c && insights.pwmLeds.length > 0) {
    const groups = new Map<string, typeof insights.pwmLeds>()
    for (const led of insights.pwmLeds) {
      const list = groups.get(led.groupPath) ?? []
      list.push(led)
      groups.set(led.groupPath, list)
    }
    for (const [, leds] of groups) {
      const first = leds[0]
      if (!first) continue
      const controller = byPath(doc, first.controllerPath)
      const address = controller ? regAddress(controller) : undefined
      const chip =
        address !== undefined
          ? chips.find((c) => c.address === address && isPwmChip(c))
          : undefined
      if (!chip || !isPwmChip(chip)) continue
      push({
        key: uniqueKey(ids, 'pwm-leds'),
        nodeName: first.groupName,
        label: 'PWM LEDs',
        compatible: 'pwm-leds',
        deviceClass: 'led',
        path: first.groupPath,
        presence: 'interactive',
        body: 'pwm-leds',
        crumb: first.controllerLabel,
        chip,
        pwmLeds: leds.map((led) => ({ channel: led.channel, label: led.label })),
        panelKind: 'led',
      })
    }
  }

  // I2C buses: every enumerated bus gets a row; only the bridged, bound one is
  // live, with the page's chips (and the tree's unanswered slots) as children.
  let busBodyUsed = false
  for (const bus of insights.i2cBuses) {
    if (bus.bridged && !avail.i2c) continue
    const live = bus.bridged && avail.i2c && !busBodyUsed
    if (live) busBodyUsed = true
    const busNode = byPath(doc, bus.path)
    const busKey = uniqueKey(ids, bus.controllerLabel)
    push({
      key: busKey,
      nodeName: busNode?.name ?? bus.controllerLabel,
      label: bus.controllerLabel,
      compatible: bus.compatible || undefined,
      deviceClass: 'i2c-bus',
      path: bus.path,
      presence: live ? 'interactive' : 'inert',
      note: live ? undefined : 'no page model',
      body: live ? 'i2c' : undefined,
      busLabel: bus.controllerLabel,
      panelKind: live ? 'i2c' : undefined,
    })

    if (live) {
      for (const row of liveBusChildren(ids, busKey, bus.controllerLabel, bus.path, bus.slots, chips)) {
        push(row)
      }
    } else {
      for (const slot of bus.slots) {
        push({
          key: uniqueKey(ids, `${bus.controllerLabel}:${hex(slot.address)}`),
          nodeName: slot.nodeName,
          label: slot.nodeName,
          compatible: slot.compatible || undefined,
          deviceClass: 'i2c-bus',
          path: `${bus.path}/${slot.nodeName}`,
          parentKey: busKey,
          presence: 'inert',
          crumb: `${bus.controllerLabel} · 0x${hex(slot.address)}`,
          busLabel: bus.controllerLabel,
        })
      }
    }
  }

  let spiBodyUsed = false
  for (const bus of insights.spiBuses) {
    if (bus.bridged && !avail.spi) continue
    const live = bus.bridged && avail.spi && !spiBodyUsed
    if (live) spiBodyUsed = true
    const busNode = byPath(doc, bus.path)
    const busKey = uniqueKey(ids, bus.controllerLabel)
    push({
      key: busKey,
      nodeName: busNode?.name ?? bus.controllerLabel,
      label: bus.controllerLabel,
      compatible: bus.compatible || undefined,
      deviceClass: 'spi-bus',
      path: bus.path,
      presence: live ? 'interactive' : 'inert',
      note: live ? undefined : 'no page model',
      body: live ? 'spi' : undefined,
      busLabel: bus.controllerLabel,
      panelKind: live ? 'spi' : undefined,
    })

    if (live) {
      for (const row of liveSpiBusChildren(
        ids,
        busKey,
        bus.controllerLabel,
        bus.path,
        bus.slots,
        spiChips,
      )) {
        push(row)
      }
    } else {
      for (const slot of bus.slots) {
        push({
          key: uniqueKey(ids, `${bus.controllerLabel}:${slot.cs.toString(16)}`),
          nodeName: slot.nodeName,
          label: slot.nodeName,
          compatible: slot.compatible || undefined,
          deviceClass: 'spi-bus',
          path: `${bus.path}/${slot.nodeName}`,
          parentKey: busKey,
          presence: 'inert',
          crumb: `${bus.controllerLabel} · CS${slot.cs}`,
          busLabel: bus.controllerLabel,
        })
      }
    }
  }

  // UART buses: every enumerated controller gets a row; children (GNSS, …)
  // nest under it the same way chips nest under I²C/SPI. The GNSS UART is
  // interactive with an "On the bus" roster — same paradigm, usually one seat.
  for (const bus of insights.uartBuses) {
    const busNode = byPath(doc, bus.path)
    const busKey = uniqueKey(ids, bus.controllerLabel)
    const liveGnss = bus.role === 'gnss' && avail.gnss && bus.slots.some((s) => s.chipId === 'gnss')
    push({
      key: busKey,
      nodeName: busNode?.name ?? bus.controllerLabel,
      label: bus.controllerLabel,
      compatible: bus.compatible || undefined,
      deviceClass: 'uart-bus',
      path: bus.path,
      presence: liveGnss ? 'interactive' : 'inert',
      note: bus.role === 'console' ? '→ terminal' : undefined,
      body: liveGnss ? 'uart' : undefined,
      busLabel: bus.controllerLabel,
    })

    for (const slot of bus.slots) {
      if (slot.chipId === 'gnss') {
        if (!avail.gnss) continue
        push({
          key: uniqueKey(ids, 'gnss'),
          nodeName: slot.nodeName,
          label: 'GNSS',
          compatible: slot.compatible || undefined,
          deviceClass: 'gnss',
          path: `${bus.path}/${slot.nodeName}`,
          parentKey: busKey,
          presence: 'interactive',
          body: 'gnss',
          crumb: bus.controllerLabel,
          panelKind: 'gnss',
        })
        continue
      }
      // Unknown UART child — keep it under the bus group for topology.
      push({
        key: uniqueKey(ids, `${bus.controllerLabel}:${slot.nodeName}`),
        nodeName: slot.nodeName,
        label: slot.nodeName,
        compatible: slot.compatible || undefined,
        deviceClass: 'uart-bus',
        path: `${bus.path}/${slot.nodeName}`,
        parentKey: busKey,
        presence: 'inert',
        crumb: bus.controllerLabel,
      })
    }
  }

  return sortByDocumentOrder(nodes, doc)
}

/** Stable ⌗ ordering: the order nodes appear in the tree source. */
function sortByDocumentOrder(nodes: DeviceNode[], doc: DtsDocument): DeviceNode[] {
  const order = new Map<string, number>()
  let index = 0
  const walk = (node: DtsNode) => {
    order.set(pathOf(node), index++)
    node.children.forEach(walk)
  }
  walk(doc.root)

  // Children stay behind their parent regardless of raw position, so a chip
  // attached at a low address does not sort ahead of its bus row.
  const rank = new Map<string, number>()
  nodes.forEach((node, i) => rank.set(node.key, i))
  return [...nodes].sort((a, b) => {
    const pa = a.parentKey ? (rank.get(a.parentKey) ?? 0) : rank.get(a.key)!
    const pb = b.parentKey ? (rank.get(b.parentKey) ?? 0) : rank.get(b.key)!
    if (pa !== pb) {
      const oa = order.get(nodes[pa].path) ?? Number.MAX_SAFE_INTEGER
      const ob = order.get(nodes[pb].path) ?? Number.MAX_SAFE_INTEGER
      if (oa !== ob) return oa - ob
      return pa - pb
    }
    // Same top-level ancestor: parent first, then children in push order.
    if (a.parentKey && !b.parentKey) return 1
    if (!a.parentKey && b.parentKey) return -1
    return rank.get(a.key)! - rank.get(b.key)!
  })
}

/**
 * Names for the no-devicetree fallback, mirroring the bundled overlays the
 * same way FALLBACK_DT_SLOTS does. Availability decides which entries appear.
 */
interface FallbackNames {
  console: { nodeName: string; compatible: string; label?: string }
  gnssUart: { nodeName: string; compatible: string; label?: string }
  audio: { nodeName: string }
  mic: { nodeName: string }
  net: { nodeName: string; compatible: string; label: string }
  gpio: { nodeName: string; compatible: string; label: string }
  i2c: { nodeName: string; compatible: string; label: string; parentPath: string }
  spi: { nodeName: string; compatible: string; label: string; parentPath: string }
  display: { nodeName: string }
  input?: { nodeName: string }
}

const A53_FALLBACK: FallbackNames = {
  console: { nodeName: 'uart@9000000', compatible: 'arm,pl011', label: 'uart0' },
  gnssUart: { nodeName: 'uart@9040000', compatible: 'arm,pl011', label: 'uart1' },
  audio: { nodeName: 'audio@90d0000' },
  mic: { nodeName: 'audio@90e0000' },
  net: { nodeName: 'virtio-net', compatible: 'virtio,net', label: 'virtio_net0' },
  gpio: { nodeName: 'virtio-gpio', compatible: 'virtio,gpio', label: 'virtio_gpio0' },
  i2c: {
    nodeName: 'virtio-i2c',
    compatible: 'virtio,i2c',
    label: 'virtio_i2c0',
    parentPath: '/soc/virtio_mmio@a000800',
  },
  spi: {
    nodeName: 'virtio-spi',
    compatible: 'virtio,spi',
    label: 'virtio_spi0',
    parentPath: '/soc/virtio_mmio@a000a00',
  },
  display: { nodeName: 'ramfb' },
  input: { nodeName: 'virtio-tablet' },
}

const RISCV32_FALLBACK: FallbackNames = {
  console: { nodeName: 'uart@10000000', compatible: 'ns16550', label: 'uart0' },
  gnssUart: { nodeName: 'uart@1000b000', compatible: 'ns16550', label: 'uart1' },
  audio: { nodeName: 'audio@10009000' },
  mic: { nodeName: 'audio@1000a000' },
  net: { nodeName: 'virtio-net', compatible: 'virtio,net', label: 'virtio_net0' },
  gpio: { nodeName: 'virtio-gpio', compatible: 'virtio,gpio', label: 'virtio_gpio0' },
  i2c: {
    nodeName: 'virtio-i2c',
    compatible: 'virtio,i2c',
    label: 'virtio_i2c0',
    parentPath: '/soc/virtio_mmio@10005000',
  },
  spi: {
    nodeName: 'virtio-spi',
    compatible: 'virtio,spi',
    label: 'virtio_spi0',
    parentPath: '/soc/virtio_mmio@10006000',
  },
  display: { nodeName: 'ramfb' },
  input: { nodeName: 'virtio-input' },
}

const M3_FALLBACK: FallbackNames = {
  console: { nodeName: 'uart@4000c000', compatible: 'ti,stellaris-uart', label: 'uart0' },
  gnssUart: { nodeName: 'uart@4000d000', compatible: 'ti,stellaris-uart', label: 'uart1' },
  audio: { nodeName: 'audio@40062000' },
  mic: { nodeName: 'audio@40063000' },
  net: { nodeName: 'ethernet@40048000', compatible: 'ti,stellaris-ethernet', label: 'eth0' },
  gpio: { nodeName: 'gpio@40061000', compatible: 'qemu,host-gpio', label: 'host_gpio' },
  i2c: {
    nodeName: 'virtio-i2c',
    compatible: 'virtio,i2c',
    label: 'virtio_i2c0',
    parentPath: '/soc',
  },
  // M3 has no virtio-mmio SPI bridge; kept for type completeness, never shown.
  spi: {
    nodeName: 'virtio-spi',
    compatible: 'virtio,spi',
    label: 'virtio_spi0',
    parentPath: '/soc',
  },
  display: { nodeName: 'ramfb' },
}

function deriveFallback(
  boardId: string,
  chips: readonly I2cChip[],
  spiChips: readonly SpiChip[],
  avail: Availability,
): DeviceNode[] {
  const names =
    boardId === 'qemu_cortex_m3'
      ? M3_FALLBACK
      : boardId === 'qemu_riscv32'
        ? RISCV32_FALLBACK
        : A53_FALLBACK
  const ids: Ids = { used: new Set() }
  const nodes: DeviceNode[] = []

  nodes.push({
    key: uniqueKey(ids, names.console.label ?? names.console.nodeName),
    nodeName: names.console.nodeName,
    label: names.console.label ?? names.console.nodeName,
    compatible: names.console.compatible,
    deviceClass: 'uart-bus',
    path: `/soc/${names.console.nodeName}`,
    presence: 'inert',
    note: '→ terminal',
  })

  if (avail.gnss) {
    const uartKey = uniqueKey(ids, names.gnssUart.label ?? names.gnssUart.nodeName)
    nodes.push({
      key: uartKey,
      nodeName: names.gnssUart.nodeName,
      label: names.gnssUart.label ?? names.gnssUart.nodeName,
      compatible: names.gnssUart.compatible,
      deviceClass: 'uart-bus',
      path: `/soc/${names.gnssUart.nodeName}`,
      presence: 'interactive',
      body: 'uart',
      busLabel: names.gnssUart.label ?? names.gnssUart.nodeName,
    })
    nodes.push({
      key: uniqueKey(ids, 'gnss'),
      nodeName: 'gnss-nmea-generic',
      label: 'GNSS',
      compatible: 'gnss-nmea-generic',
      deviceClass: 'gnss',
      path: `/soc/${names.gnssUart.nodeName}/gnss-nmea-generic`,
      parentKey: uartKey,
      presence: 'interactive',
      body: 'gnss',
      crumb: names.gnssUart.label,
      panelKind: 'gnss',
    })
  }

  if (avail.audio) {
    nodes.push({
      key: uniqueKey(ids, 'audio'),
      nodeName: names.audio.nodeName,
      label: 'Speaker',
      compatible: 'qemu,host-audio',
      deviceClass: 'audio',
      path: `/soc/${names.audio.nodeName}`,
      presence: 'interactive',
      body: 'speaker',
      panelKind: 'audio',
    })
  }
  if (avail.mic) {
    nodes.push({
      key: uniqueKey(ids, 'mic'),
      nodeName: names.mic.nodeName,
      label: 'Microphone',
      compatible: 'qemu,host-mic',
      deviceClass: 'audio',
      path: `/soc/${names.mic.nodeName}`,
      presence: 'interactive',
      body: 'mic',
      panelKind: 'audio',
    })
  }

  if (avail.net) {
    nodes.push({
      key: uniqueKey(ids, 'net'),
      nodeName: names.net.nodeName,
      label: 'Network',
      compatible: names.net.compatible,
      deviceClass: 'net',
      path: `/soc/${names.net.nodeName}`,
      presence: 'interactive',
      body: 'net',
      crumb: names.net.label,
      panelKind: 'net',
    })
  }

  if (avail.gpio) {
    nodes.push({
      key: uniqueKey(ids, 'gpio'),
      nodeName: names.gpio.nodeName,
      label: 'GPIO',
      compatible: names.gpio.compatible,
      deviceClass: 'gpio',
      path: `/soc/${names.gpio.nodeName}`,
      presence: 'interactive',
      body: 'gpio',
      crumb: names.gpio.label,
      panelKind: 'gpio',
    })
    nodes.push({
      key: uniqueKey(ids, 'gpio-keys'),
      nodeName: 'keys',
      label: 'GPIO Keys',
      compatible: 'gpio-keys',
      deviceClass: 'keys',
      path: '/keys',
      presence: 'interactive',
      body: 'gpio-keys',
      crumb: names.gpio.label,
      panelKind: 'keys',
    })
    // Fallback fan-out always includes LEDs (hostGpio FALLBACK_LEDS) — same
    // LED-class split as the devicetree path.
    nodes.push({
      key: uniqueKey(ids, 'gpio-leds'),
      nodeName: 'leds',
      label: 'GPIO LEDs',
      compatible: 'gpio-leds',
      deviceClass: 'led',
      path: '/leds',
      presence: 'interactive',
      body: 'gpio-leds',
      crumb: names.gpio.label,
      panelKind: 'led',
    })
  }

  if (avail.display) {
    nodes.push({
      key: uniqueKey(ids, 'display'),
      nodeName: names.display.nodeName,
      label: 'Display',
      compatible: 'qemu,ramfb',
      deviceClass: 'display',
      path: `/soc/${names.display.nodeName}`,
      presence: 'inert',
      note: 'on stage',
    })
  }

  if (avail.input && names.input) {
    nodes.push({
      key: uniqueKey(ids, 'input'),
      nodeName: names.input.nodeName,
      label: 'Touch input',
      compatible: 'virtio,input',
      deviceClass: 'other',
      path: `/soc/${names.input.nodeName}`,
      presence: 'inert',
      note: '→ display touch',
    })
  }

  if (avail.i2c) {
    const busPath = `${names.i2c.parentPath}/${names.i2c.nodeName}`
    const busKey = uniqueKey(ids, names.i2c.label)
    nodes.push({
      key: busKey,
      nodeName: names.i2c.nodeName,
      label: names.i2c.label,
      compatible: names.i2c.compatible,
      deviceClass: 'i2c-bus',
      path: busPath,
      presence: 'interactive',
      body: 'i2c',
      busLabel: names.i2c.label,
      panelKind: 'i2c',
    })
    const slots: I2cSlot[] = Object.entries(FALLBACK_DT_SLOTS).map(([address, chipId]) => ({
      address: Number(address),
      compatible: partCompatible(chipId) ?? '',
      chipId,
      nodeName: `${chipId}@${hex(Number(address))}`,
    }))
    nodes.push(...liveBusChildren(ids, busKey, names.i2c.label, busPath, slots, chips))
  }

  if (avail.spi) {
    const busPath = `${names.spi.parentPath}/${names.spi.nodeName}`
    const busKey = uniqueKey(ids, names.spi.label)
    nodes.push({
      key: busKey,
      nodeName: names.spi.nodeName,
      label: names.spi.label,
      compatible: names.spi.compatible,
      deviceClass: 'spi-bus',
      path: busPath,
      presence: 'interactive',
      body: 'spi',
      busLabel: names.spi.label,
      panelKind: 'spi',
    })
    const slots: SpiSlot[] = spiChips.map((chip) => ({
      cs: chip.cs,
      compatible: isSpiFlashChip(chip)
        ? 'jedec,spi-nor'
        : isSct2024(chip)
          ? 'sct,sct2024'
          : isWs2812(chip)
            ? 'worldsemi,ws2812-spi'
            : isPt6314(chip)
              ? 'ptc,pt6314'
              : '',
      chipId: isSpiFlashChip(chip)
        ? 'w25q'
        : isSct2024(chip)
          ? 'sct2024'
          : isWs2812(chip)
            ? 'ws2812'
            : isPt6314(chip)
              ? 'pt6314'
              : undefined,
      nodeName: isSct2024(chip)
        ? `sct2024@${chip.cs}`
        : isWs2812(chip)
          ? `ws2812@${chip.cs}`
          : isPt6314(chip)
            ? `pt6314@${chip.cs}`
            : `spi-dev@${chip.cs}`,
    }))
    nodes.push(...liveSpiBusChildren(ids, busKey, names.spi.label, busPath, slots, spiChips))
  }

  return nodes
}

/**
 * The inventory: what the dock shows, before any view is chosen. Pure — the
 * caller (hooks/useDeviceTree) supplies the tree, the chips and availability.
 */
export function deriveDeviceInventory(
  tree: Pick<DeviceTreeState, 'name' | 'doc' | 'insights'> | null,
  chips: readonly I2cChip[],
  spiChips: readonly SpiChip[],
  avail: Availability,
  boardId: string,
): DeviceInventory {
  if (tree?.doc && tree.insights) {
    return {
      nodes: deriveFromTree(tree.doc, tree.insights, chips, spiChips, avail),
      source: 'devicetree',
      rootName: tree.insights.model,
      treeName: tree.name,
    }
  }
  return {
    nodes: deriveFallback(boardId, chips, spiChips, avail),
    source: 'fallback',
  }
}

/**
 * Flatten the inventory into what one view renders, top to bottom. Both views
 * emit the same `device` rows (same keys, same nodes) — only the scaffolding
 * around them differs, which is what keeps a view flip a pure re-arrangement.
 */
export function buildRowList(inventory: DeviceInventory, view: DockView): Row[] {
  return view === 'devicetree' ? devicetreeRows(inventory) : classRows(inventory.nodes)
}

function devicetreeRows(inventory: DeviceInventory): Row[] {
  const { nodes } = inventory
  const rows: Row[] = []

  if (inventory.rootName || inventory.treeName) {
    rows.push({
      kind: 'struct',
      key: 'root',
      name: '/',
      depth: 0,
      note: [inventory.rootName, inventory.treeName].filter(Boolean).join(' — '),
    })
  }
  const baseDepth = rows.length > 0 ? 1 : 0

  const children = new Map<string, DeviceNode[]>()
  const topLevel: DeviceNode[] = []
  for (const node of nodes) {
    if (node.parentKey) {
      const list = children.get(node.parentKey) ?? []
      list.push(node)
      children.set(node.parentKey, list)
    } else {
      topLevel.push(node)
    }
  }

  // Shared first path segments (in practice: `soc`) become structural rows
  // when more than one top-level row lives under them.
  const segmentOf = (node: DeviceNode) => node.path.split('/').filter(Boolean)[0] ?? ''
  const segmentCounts = new Map<string, number>()
  for (const node of topLevel) {
    const seg = segmentOf(node)
    segmentCounts.set(seg, (segmentCounts.get(seg) ?? 0) + 1)
  }

  const emitted = new Set<string>()
  const emit = (node: DeviceNode, depth: number) => {
    rows.push({ kind: 'device', node, depth })
    for (const child of children.get(node.key) ?? []) emit(child, depth + 1)
  }

  for (const node of topLevel) {
    const seg = segmentOf(node)
    const grouped = seg !== '' && (segmentCounts.get(seg) ?? 0) >= 2
    if (grouped && !emitted.has(seg)) {
      emitted.add(seg)
      rows.push({ kind: 'struct', key: `struct:${seg}`, name: seg, depth: baseDepth })
    }
    emit(node, grouped ? baseDepth + 1 : baseDepth)
  }

  return rows
}

function classRows(nodes: DeviceNode[]): Row[] {
  const rows: Row[] = []
  const byKey = new Map(nodes.map((node) => [node.key, node]))

  for (const cls of CLASS_ORDER) {
    const members = nodes.filter((node) => node.deviceClass === cls)
    if (members.length === 0) continue
    rows.push({
      kind: 'group',
      key: `group:${cls}`,
      deviceClass: cls,
      label: CLASS_LABELS[cls],
      count: members.length,
    })
    for (const node of members) {
      // A row whose ⌗ parent landed in the same group (an unbridged bus's
      // slots under their bus) keeps one level of nesting; everything else is
      // flat — chips already carry their bus in the breadcrumb.
      const parent = node.parentKey ? byKey.get(node.parentKey) : undefined
      rows.push({ kind: 'device', node, depth: parent?.deviceClass === cls ? 1 : 0 })
    }
  }
  return rows
}
