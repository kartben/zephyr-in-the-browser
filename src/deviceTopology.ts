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
 * Availability gates what is *interactive*, not what is *listed*. A bridge the
 * runtime has not exposed yet (early boot, mock backend) still gets its row —
 * inert — so the dock's membership and order stay put from the first paint
 * instead of inserting and shoving neighbours as each bridge comes up.
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
  | 'bluetooth'
  | 'audio'
  | 'net'
  | 'other'

/** Which extracted panel body a row hosts (see components/dock/deviceBodies). */
export type BodyKind =
  | 'sensor'
  | 'memory'
  | 'display'
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
  | 'bluetooth'
  | 'spi-flash'
  | 'disk'
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
  bluetooth: boolean
  gpio: boolean
  audio: boolean
  mic: boolean
  net: boolean
  i2c: boolean
  spi: boolean
  display: boolean
  input: boolean
  disk: boolean
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
   * (console UART, an unbridged bus, or a bridged surface waiting on its
   * runtime bridge). ghost: the devicetree declares it but nothing answers on
   * the bus — the NAK/bus-error demo, visible.
   */
  presence: 'interactive' | 'inert' | 'ghost'
  /** Short annotation ('→ terminal', 'no page model', 'NAK — detached'). */
  note?: string
  /** Small qualifier chip ('not in devicetree' for an attached-but-undeclared part). */
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
  /** Chip select this part sits on, for rows under a SPI bus — drives the CS dot. */
  spiCs?: number
  /** The legacy panel kind whose expand-on-boot rule this row inherits. */
  panelKind?: PanelKind
}

export interface DeviceInventory {
  nodes: DeviceNode[]
  /**
   * - `devicetree` — derived from the running sample/user `.dts`
   * - `fallback` — confirmed no tree; static board inventory
   * - `pending` — tree still expected (initial load / fetch in flight); empty
   */
  source: 'devicetree' | 'fallback' | 'pending'
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
  bluetooth: 'Bluetooth',
  audio: 'Audio',
  net: 'Network',
  other: 'Other devices',
}

/**
 * The PanelKind a class answers to in a Learn preset (`DockSeed.only`).
 * `panelKind` on the node itself only exists once the row's bridge is live,
 * so preset visibility cannot key off it alone — a preset must keep a row on
 * screen *before* its sample brings it up. Classes with no kind (UARTs, the
 * catch-all) are simply not addressable by a preset and hide under one.
 */
const CLASS_PRESET_KIND: Record<DeviceClass, PanelKind | undefined> = {
  sensor: 'sensor',
  display: 'display',
  auxdisplay: 'auxdisplay',
  led: 'led',
  pwm: 'pwm',
  dac: 'dac',
  'fuel-gauge': 'fuel-gauge',
  memory: 'disk',
  rtc: 'i2c',
  'i2c-bus': 'i2c',
  'spi-bus': 'spi',
  'uart-bus': undefined,
  'can-bus': 'can',
  gpio: 'gpio',
  keys: 'keys',
  buzzer: 'buzzer',
  stepper: 'stepper',
  gnss: 'gnss',
  bluetooth: 'bluetooth',
  audio: 'audio',
  net: 'net',
  other: undefined,
}

/** Every kind under which a row counts for a preset (its own, plus its class's). */
export function presetPanelKinds(node: DeviceNode): PanelKind[] {
  const kinds: PanelKind[] = []
  if (node.panelKind) kinds.push(node.panelKind)
  const fromClass = CLASS_PRESET_KIND[node.deviceClass]
  if (fromClass && fromClass !== node.panelKind) kinds.push(fromClass)
  return kinds
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
  'bluetooth',
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

/** Declared I²C children under a bus that is not live yet — same keys/classes as ghosts. */
function declaredI2cChildren(
  ids: Ids,
  busKey: string,
  busLabel: string,
  busPath: string,
  slots: readonly I2cSlot[],
): DeviceNode[] {
  return [...slots]
    .sort((a, b) => a.address - b.address)
    .map((slot) => {
      const type = slot.chipId ? chipType(slot.chipId) : undefined
      return {
        key: uniqueKey(ids, `${busLabel}:${hex(slot.address)}`),
        nodeName: slot.nodeName,
        label: type?.label ?? slot.compatible ?? slot.nodeName,
        compatible: slot.compatible || undefined,
        deviceClass: type ? KIND_TO_CLASS[type.kind] : 'i2c-bus',
        path: `${busPath}/${slot.nodeName}`,
        parentKey: busKey,
        presence: 'inert' as const,
        crumb: `${busLabel} · 0x${hex(slot.address)}`,
        partId: slot.chipId,
        busLabel,
      }
    })
}

/** Declared SPI children under a bus that is not live yet — same keys as live/ghost rows. */
function declaredSpiChildren(
  ids: Ids,
  busKey: string,
  busLabel: string,
  busPath: string,
  slots: readonly SpiSlot[],
): DeviceNode[] {
  return [...slots]
    .sort((a, b) => a.cs - b.cs)
    .map((slot) => ({
      key: uniqueKey(ids, `${busLabel}:${slot.cs.toString(16)}`),
      nodeName: slot.nodeName,
      label: slot.compatible || slot.nodeName,
      compatible: slot.compatible || undefined,
      deviceClass:
        slot.chipId === 'w25q'
          ? ('memory' as const)
          : slot.chipId === 'sct2024' || slot.chipId === 'ws2812'
            ? ('led' as const)
            : slot.chipId === 'pt6314'
              ? ('auxdisplay' as const)
              : slot.chipId === 'tmc50xx'
                ? ('stepper' as const)
                : ('spi-bus' as const),
      path: `${busPath}/${slot.nodeName}`,
      parentKey: busKey,
      presence: 'inert' as const,
      crumb: `${busLabel} · CS${slot.cs}`,
      partId: slot.chipId,
      busLabel,
    }))
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
        tag: slot ? undefined : 'not in devicetree',
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
        tag: slot ? undefined : 'not in devicetree',
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
        spiCs: cs,
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

  {
    const speaker = firstOkay('qemu,host-audio')
    if (speaker) {
      const live = avail.audio
      push({
        key: uniqueKey(ids, 'audio'),
        nodeName: speaker.name,
        label: 'Speaker',
        compatible: compatibles(speaker)[0],
        deviceClass: 'audio',
        path: pathOf(speaker),
        presence: live ? 'interactive' : 'inert',
        body: live ? 'speaker' : undefined,
        crumb: speaker.labels[0],
        panelKind: live ? 'audio' : undefined,
      })
    }
  }
  {
    const mic = firstOkay('qemu,host-mic')
    if (mic) {
      const live = avail.mic
      push({
        key: uniqueKey(ids, 'mic'),
        nodeName: mic.name,
        label: 'Microphone',
        compatible: compatibles(mic)[0],
        deviceClass: 'audio',
        path: pathOf(mic),
        presence: live ? 'interactive' : 'inert',
        body: live ? 'mic' : undefined,
        crumb: mic.labels[0],
        panelKind: live ? 'audio' : undefined,
      })
    }
  }

  {
    const nic = firstOkay('virtio,net', 'ti,stellaris-ethernet')
    if (nic) {
      const live = avail.net
      push({
        key: uniqueKey(ids, 'net'),
        nodeName: nic.name,
        label: 'Network',
        compatible: compatibles(nic)[0],
        deviceClass: 'net',
        path: pathOf(nic),
        presence: live ? 'interactive' : 'inert',
        body: live ? 'net' : undefined,
        crumb: nic.labels[0],
        panelKind: live ? 'net' : undefined,
      })
    }
  }

  {
    const display = firstOkay('qemu,ramfb', 'virtio,gpu')
    if (display) {
      const live = avail.display
      push({
        key: uniqueKey(ids, 'display'),
        nodeName: display.name,
        label: 'Display',
        compatible: compatibles(display)[0],
        deviceClass: 'display',
        path: pathOf(display),
        presence: live ? 'interactive' : 'inert',
        body: live ? 'display' : undefined,
        crumb: display.labels[0],
        panelKind: live ? 'display' : undefined,
      })
    }
  }

  {
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

  {
    // The virtio-blk disk. A device row rather than an Instrument because the
    // guest's tree really does declare it — and `memory` rather than a class of
    // its own so it sits beside the SPI NOR, which is the other storage medium
    // and the panel this one is modelled on.
    const disk = firstOkay('virtio,blk')
    if (disk) {
      const live = avail.disk
      push({
        key: uniqueKey(ids, 'disk'),
        nodeName: disk.name,
        label: 'Disk',
        compatible: compatibles(disk)[0],
        deviceClass: 'memory',
        path: pathOf(disk),
        presence: live ? 'interactive' : 'inert',
        body: live ? 'disk' : undefined,
        crumb: disk.labels[0],
        panelKind: live ? 'disk' : undefined,
      })
    }
  }

  // GPIO controllers: the bridged one drives the panel; the rest of the tree's
  // controllers are still listed, inert — a user-dropped board file has them.
  // Claim the primary `gpio` key as soon as a bridged controller is known, even
  // before avail.gpio, so the row identity does not change when the bridge lands.
  let gpioBodyUsed = false
  for (const ctl of insights.gpioControllers) {
    const primary = ctl.bridged && !gpioBodyUsed
    if (primary) gpioBodyUsed = true
    const live = primary && avail.gpio
    const pathParts = ctl.path.split('/').filter(Boolean)
    const nodeName = pathParts[pathParts.length - 1] ?? ctl.controllerLabel
    push({
      key: uniqueKey(ids, primary ? 'gpio' : `gpio:${ctl.controllerLabel}`),
      nodeName,
      label: primary ? 'GPIO' : ctl.controllerLabel,
      compatible: ctl.compatible || undefined,
      deviceClass: 'gpio',
      path: ctl.path,
      presence: live ? 'interactive' : 'inert',
      note: live || ctl.bridged ? undefined : 'no page model',
      body: live ? 'gpio' : undefined,
      crumb: ctl.controllerLabel,
      panelKind: live ? 'gpio' : undefined,
    })
  }

  // gpio-keys: Keys-class row — buttons leave the GPIO controller card.
  const bridgedKeys = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.buttons.length > 0,
  )
  if (bridgedKeys) {
    const live = avail.gpio
    const keysNode = nodesByCompatible(doc, 'gpio-keys').find(isEffectivelyOkay)
    push({
      key: uniqueKey(ids, 'gpio-keys'),
      nodeName: keysNode?.name ?? 'keys',
      label: 'GPIO Keys',
      compatible: 'gpio-keys',
      deviceClass: 'keys',
      path: keysNode ? pathOf(keysNode) : '/keys',
      presence: live ? 'interactive' : 'inert',
      body: live ? 'gpio-keys' : undefined,
      crumb: bridgedKeys.controllerLabel,
      panelKind: live ? 'keys' : undefined,
    })
  }

  // gpio-leds groups: LED-class row, like pwm-leds / gpio-buzzer — not folded
  // into the GPIO button grid.
  const bridgedLeds = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.leds.length > 0,
  )
  if (bridgedLeds) {
    const live = avail.gpio
    const ledsNode = nodesByCompatible(doc, 'gpio-leds').find(isEffectivelyOkay)
    push({
      key: uniqueKey(ids, 'gpio-leds'),
      nodeName: ledsNode?.name ?? 'leds',
      label: 'GPIO LEDs',
      compatible: 'gpio-leds',
      deviceClass: 'led',
      path: ledsNode ? pathOf(ledsNode) : '/leds',
      presence: live ? 'interactive' : 'inert',
      body: live ? 'gpio-leds' : undefined,
      crumb: bridgedLeds.controllerLabel,
      panelKind: live ? 'led' : undefined,
    })
  }

  // gpio-7-segment: multiplexed LED digits — own auxdisplay row (not a bus chip).
  const bridgedSeven = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.sevenSegs.length > 0,
  )
  if (bridgedSeven) {
    const live = avail.gpio
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
        presence: live ? 'interactive' : 'inert',
        body: live ? 'seven-seg' : undefined,
        crumb: `${disp.digits.length}-digit · ${bridgedSeven.controllerLabel}`,
        panelKind: live ? 'auxdisplay' : undefined,
      })
    }
  }

  // gpio-buzzer leaves: one dock body for every buzzers on the bridged controller.
  // Not folded into the GPIO grid — shake / vibrate deserves its own row.
  const bridgedBuzz = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.buzzers.length > 0,
  )
  if (bridgedBuzz) {
    const live = avail.gpio
    const buzzerNode = nodesByCompatible(doc, 'gpio-buzzer').find(isEffectivelyOkay)
    const first = bridgedBuzz.buzzers[0]
    push({
      key: uniqueKey(ids, 'buzzer'),
      nodeName: buzzerNode?.name ?? 'buzzer',
      label: first?.label ?? 'Buzzer',
      compatible: 'gpio-buzzer',
      deviceClass: 'buzzer',
      path: buzzerNode ? pathOf(buzzerNode) : '/buzzer',
      presence: live ? 'interactive' : 'inert',
      body: live ? 'buzzer' : undefined,
      crumb: `pin ${first?.id}`,
      panelKind: live ? 'buzzer' : undefined,
    })
  }

  // gpio step/dir steppers: observe STEP/DIR edges like buzzer observes level.
  const bridgedStep = insights.gpioControllers.find(
    (ctl) => ctl.bridged && ctl.steppers.length > 0,
  )
  if (bridgedStep) {
    const live = avail.gpio
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
      presence: live ? 'interactive' : 'inert',
      body: live ? 'stepper' : undefined,
      crumb: first ? `STEP ${first.stepPin} · DIR ${first.dirPin}` : undefined,
      panelKind: live ? 'stepper' : undefined,
    })
  }

  // pwm-leds groups: brightness strip driven by an attached PwmChip. Sibling of
  // the PWM controller row — see docs/pwm-leds.md. Listed inert while I²C is
  // still coming up so the row does not insert later.
  if (insights.pwmLeds.length > 0) {
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
      const live = avail.i2c && !!chip && isPwmChip(chip)
      // Without a live chip and with I²C already up, skip — the bus ghost covers it.
      if (!live && avail.i2c) continue
      push({
        key: uniqueKey(ids, 'pwm-leds'),
        nodeName: first.groupName,
        label: 'PWM LEDs',
        compatible: 'pwm-leds',
        deviceClass: 'led',
        path: first.groupPath,
        presence: live ? 'interactive' : 'inert',
        body: live ? 'pwm-leds' : undefined,
        crumb: first.controllerLabel,
        chip: live ? chip : undefined,
        pwmLeds: leds.map((led) => ({ channel: led.channel, label: led.label })),
        panelKind: live ? 'led' : undefined,
      })
    }
  }

  // I2C buses: every enumerated bus gets a row; only the bridged, bound one is
  // live, with the page's chips (and the tree's unanswered slots) as children.
  let busBodyUsed = false
  for (const bus of insights.i2cBuses) {
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
      note: live || bus.bridged ? undefined : 'no page model',
      body: live ? 'i2c' : undefined,
      busLabel: bus.controllerLabel,
      panelKind: live ? 'i2c' : undefined,
    })

    if (live) {
      for (const row of liveBusChildren(ids, busKey, bus.controllerLabel, bus.path, bus.slots, chips)) {
        push(row)
      }
    } else {
      for (const row of declaredI2cChildren(ids, busKey, bus.controllerLabel, bus.path, bus.slots)) {
        push(row)
      }
    }
  }

  let spiBodyUsed = false
  for (const bus of insights.spiBuses) {
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
      note: live || bus.bridged ? undefined : 'no page model',
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
      for (const row of declaredSpiChildren(ids, busKey, bus.controllerLabel, bus.path, bus.slots)) {
        push(row)
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
    const liveBt =
      bus.role === 'bluetooth' &&
      avail.bluetooth &&
      bus.slots.some((s) => s.chipId === 'bluetooth')
    const liveUart = liveGnss || liveBt
    push({
      key: busKey,
      nodeName: busNode?.name ?? bus.controllerLabel,
      label: bus.controllerLabel,
      compatible: bus.compatible || undefined,
      deviceClass: 'uart-bus',
      path: bus.path,
      presence: liveUart ? 'interactive' : 'inert',
      note: bus.role === 'console' ? '→ terminal' : undefined,
      body: liveGnss ? 'uart' : undefined,
      busLabel: bus.controllerLabel,
    })

    for (const slot of bus.slots) {
      if (slot.chipId === 'gnss') {
        const live = avail.gnss
        push({
          key: uniqueKey(ids, 'gnss'),
          nodeName: slot.nodeName,
          label: 'GNSS',
          compatible: slot.compatible || undefined,
          deviceClass: 'gnss',
          path: `${bus.path}/${slot.nodeName}`,
          parentKey: busKey,
          presence: live ? 'interactive' : 'inert',
          body: live ? 'gnss' : undefined,
          crumb: bus.controllerLabel,
          panelKind: live ? 'gnss' : undefined,
        })
        continue
      }
      if (slot.chipId === 'bluetooth') {
        const live = avail.bluetooth
        push({
          key: uniqueKey(ids, 'bluetooth'),
          nodeName: slot.nodeName,
          label: 'Bluetooth HCI',
          compatible: slot.compatible || undefined,
          deviceClass: 'bluetooth',
          path: `${bus.path}/${slot.nodeName}`,
          parentKey: busKey,
          presence: live ? 'interactive' : 'inert',
          body: live ? 'bluetooth' : undefined,
          crumb: bus.controllerLabel,
          panelKind: live ? 'bluetooth' : undefined,
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
 * same way FALLBACK_DT_SLOTS does. Every named surface is listed; availability
 * only flips presence between inert and interactive. Optional fields are
 * omitted on boards that never expose them (M3 has no virtio I²C/SPI/display).
 */
interface FallbackNames {
  console: { nodeName: string; compatible: string; label?: string }
  gnssUart: { nodeName: string; compatible: string; label?: string }
  audio: { nodeName: string }
  mic: { nodeName: string }
  net: { nodeName: string; compatible: string; label: string }
  gpio: { nodeName: string; compatible: string; label: string }
  i2c?: { nodeName: string; compatible: string; label: string; parentPath: string }
  spi?: { nodeName: string; compatible: string; label: string; parentPath: string }
  display?: { nodeName: string }
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

  {
    const live = avail.gnss
    const uartKey = uniqueKey(ids, names.gnssUart.label ?? names.gnssUart.nodeName)
    nodes.push({
      key: uartKey,
      nodeName: names.gnssUart.nodeName,
      label: names.gnssUart.label ?? names.gnssUart.nodeName,
      compatible: names.gnssUart.compatible,
      deviceClass: 'uart-bus',
      path: `/soc/${names.gnssUart.nodeName}`,
      presence: live ? 'interactive' : 'inert',
      body: live ? 'uart' : undefined,
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
      presence: live ? 'interactive' : 'inert',
      body: live ? 'gnss' : undefined,
      crumb: names.gnssUart.label,
      panelKind: live ? 'gnss' : undefined,
    })
  }

  // HCI UART — A53/RISC-V only in the real machine; shown in fallback whenever
  // the page has an hci0 bridge so the mock backend can demo the dock row.
  if (avail.bluetooth && boardId !== 'qemu_cortex_m3') {
    const hciUart =
      boardId === 'qemu_riscv32'
        ? { nodeName: 'uart@1000c000', compatible: 'ns16550', label: 'uart2' }
        : { nodeName: 'uart@90f0000', compatible: 'arm,pl011', label: 'uart2' }
    const uartKey = uniqueKey(ids, hciUart.label)
    nodes.push({
      key: uartKey,
      nodeName: hciUart.nodeName,
      label: hciUart.label,
      compatible: hciUart.compatible,
      deviceClass: 'uart-bus',
      path: `/soc/${hciUart.nodeName}`,
      presence: 'interactive',
      busLabel: hciUart.label,
    })
    nodes.push({
      key: uniqueKey(ids, 'bluetooth'),
      nodeName: 'bt_hci_uart',
      label: 'Bluetooth HCI',
      compatible: 'zephyr,bt-hci-uart',
      deviceClass: 'bluetooth',
      path: `/soc/${hciUart.nodeName}/bt_hci_uart`,
      parentKey: uartKey,
      presence: 'interactive',
      body: 'bluetooth',
      crumb: hciUart.label,
      panelKind: 'bluetooth',
    })
  }

  {
    const live = avail.audio
    nodes.push({
      key: uniqueKey(ids, 'audio'),
      nodeName: names.audio.nodeName,
      label: 'Speaker',
      compatible: 'qemu,host-audio',
      deviceClass: 'audio',
      path: `/soc/${names.audio.nodeName}`,
      presence: live ? 'interactive' : 'inert',
      body: live ? 'speaker' : undefined,
      panelKind: live ? 'audio' : undefined,
    })
  }
  {
    const live = avail.mic
    nodes.push({
      key: uniqueKey(ids, 'mic'),
      nodeName: names.mic.nodeName,
      label: 'Microphone',
      compatible: 'qemu,host-mic',
      deviceClass: 'audio',
      path: `/soc/${names.mic.nodeName}`,
      presence: live ? 'interactive' : 'inert',
      body: live ? 'mic' : undefined,
      panelKind: live ? 'audio' : undefined,
    })
  }

  {
    const live = avail.net
    nodes.push({
      key: uniqueKey(ids, 'net'),
      nodeName: names.net.nodeName,
      label: 'Network',
      compatible: names.net.compatible,
      deviceClass: 'net',
      path: `/soc/${names.net.nodeName}`,
      presence: live ? 'interactive' : 'inert',
      body: live ? 'net' : undefined,
      crumb: names.net.label,
      panelKind: live ? 'net' : undefined,
    })
  }

  {
    const live = avail.gpio
    nodes.push({
      key: uniqueKey(ids, 'gpio'),
      nodeName: names.gpio.nodeName,
      label: 'GPIO',
      compatible: names.gpio.compatible,
      deviceClass: 'gpio',
      path: `/soc/${names.gpio.nodeName}`,
      presence: live ? 'interactive' : 'inert',
      body: live ? 'gpio' : undefined,
      crumb: names.gpio.label,
      panelKind: live ? 'gpio' : undefined,
    })
    nodes.push({
      key: uniqueKey(ids, 'gpio-keys'),
      nodeName: 'keys',
      label: 'GPIO Keys',
      compatible: 'gpio-keys',
      deviceClass: 'keys',
      path: '/keys',
      presence: live ? 'interactive' : 'inert',
      body: live ? 'gpio-keys' : undefined,
      crumb: names.gpio.label,
      panelKind: live ? 'keys' : undefined,
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
      presence: live ? 'interactive' : 'inert',
      body: live ? 'gpio-leds' : undefined,
      crumb: names.gpio.label,
      panelKind: live ? 'led' : undefined,
    })
  }

  if (names.display) {
    const live = avail.display
    nodes.push({
      key: uniqueKey(ids, 'display'),
      nodeName: names.display.nodeName,
      label: 'Display',
      compatible: 'qemu,ramfb',
      deviceClass: 'display',
      path: `/soc/${names.display.nodeName}`,
      presence: live ? 'interactive' : 'inert',
      body: live ? 'display' : undefined,
      panelKind: live ? 'display' : undefined,
    })
  }

  if (names.input) {
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

  if (names.i2c) {
    const busPath = `${names.i2c.parentPath}/${names.i2c.nodeName}`
    const busKey = uniqueKey(ids, names.i2c.label)
    const live = avail.i2c
    nodes.push({
      key: busKey,
      nodeName: names.i2c.nodeName,
      label: names.i2c.label,
      compatible: names.i2c.compatible,
      deviceClass: 'i2c-bus',
      path: busPath,
      presence: live ? 'interactive' : 'inert',
      body: live ? 'i2c' : undefined,
      busLabel: names.i2c.label,
      panelKind: live ? 'i2c' : undefined,
    })
    const slots: I2cSlot[] = Object.entries(FALLBACK_DT_SLOTS).map(([address, chipId]) => ({
      address: Number(address),
      compatible: partCompatible(chipId) ?? '',
      chipId,
      nodeName: `${chipId}@${hex(Number(address))}`,
    }))
    if (live) {
      nodes.push(...liveBusChildren(ids, busKey, names.i2c.label, busPath, slots, chips))
    } else {
      nodes.push(...declaredI2cChildren(ids, busKey, names.i2c.label, busPath, slots))
    }
  }

  if (names.spi) {
    const busPath = `${names.spi.parentPath}/${names.spi.nodeName}`
    const busKey = uniqueKey(ids, names.spi.label)
    const live = avail.spi
    nodes.push({
      key: busKey,
      nodeName: names.spi.nodeName,
      label: names.spi.label,
      compatible: names.spi.compatible,
      deviceClass: 'spi-bus',
      path: busPath,
      presence: live ? 'interactive' : 'inert',
      body: live ? 'spi' : undefined,
      busLabel: names.spi.label,
      panelKind: live ? 'spi' : undefined,
    })
    if (live) {
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
    } else {
      // Default flash seat — same CS0 the managed bus attaches — so the child
      // row is already in place before the bridge binds.
      const slots: SpiSlot[] = [
        {
          cs: 0,
          compatible: 'jedec,spi-nor',
          chipId: 'w25q',
          nodeName: 'spi-dev@0',
        },
      ]
      nodes.push(...declaredSpiChildren(ids, busKey, names.spi.label, busPath, slots))
    }
  }

  return nodes
}

/**
 * The inventory: what the dock shows, before any view is chosen. Pure — the
 * caller (hooks/useDeviceTree) supplies the tree, the chips and availability.
 *
 * `phase` comes from the devicetree store: while a sample `.dts` is still
 * expected (`pending`), return an empty inventory rather than the packed
 * static fallback — otherwise the dock flashes every board peripheral and
 * then shrinks to the sample's enabled nodes when the fetch lands.
 */
export function deriveDeviceInventory(
  tree: Pick<DeviceTreeState, 'name' | 'doc' | 'insights'> | null,
  chips: readonly I2cChip[],
  spiChips: readonly SpiChip[],
  avail: Availability,
  boardId: string,
  phase: 'pending' | 'ready' | 'absent' = 'absent',
): DeviceInventory {
  if (tree?.doc && tree.insights) {
    return {
      nodes: deriveFromTree(tree.doc, tree.insights, chips, spiChips, avail),
      source: 'devicetree',
      rootName: tree.insights.model,
      treeName: tree.name,
    }
  }
  if (phase === 'pending') {
    return { nodes: [], source: 'pending' }
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
