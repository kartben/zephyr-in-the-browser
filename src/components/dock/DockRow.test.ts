import { describe, expect, it } from 'vitest'
import { dockRowSecondary, dockRowTitle } from './DockRow'
import type { DeviceNode } from '@/deviceTopology'

function node(partial: Partial<DeviceNode> & Pick<DeviceNode, 'key' | 'nodeName' | 'label'>): DeviceNode {
  return {
    deviceClass: 'sensor',
    path: `/${partial.nodeName}`,
    presence: 'interactive',
    ...partial,
  }
}

describe('dockRowSecondary', () => {
  it('shows the bus crumb in the classes view', () => {
    const chip = node({
      key: 'virtio_i2c0:48',
      nodeName: 'tmp112@48',
      label: 'TMP112 temperature',
      compatible: 'ti,tmp112',
      partId: 'tmp112',
      crumb: 'I²C · 0x48',
      busLabel: 'virtio_i2c0',
    })
    expect(dockRowSecondary(chip, 'classes')).toBe('I²C · 0x48')
  })

  it('shows the friendly label in the device-tree view, not the compatible', () => {
    const chip = node({
      key: 'virtio_i2c0:48',
      nodeName: 'tmp112@48',
      label: 'TMP112 temperature',
      compatible: 'ti,tmp112',
      partId: 'tmp112',
      crumb: 'I²C · 0x48',
      busLabel: 'virtio_i2c0',
    })
    // Compatible belongs on PartIdentityStrip once the body expands — do not
    // repeat it beside every ⌗ row.
    expect(dockRowSecondary(chip, 'devicetree')).toBe('TMP112 temperature')
    expect(dockRowSecondary(chip, 'devicetree')).not.toBe('ti,tmp112')
  })

  it('omits secondary for a catalogued part whose label matches the node name', () => {
    const chip = node({
      key: 'virtio_i2c0:48',
      nodeName: 'TMP112',
      label: 'TMP112',
      compatible: 'ti,tmp112',
      partId: 'tmp112',
    })
    expect(dockRowSecondary(chip, 'devicetree')).toBeUndefined()
  })

  it('falls back to compatible for uncatalogued nodes without a distinct label', () => {
    const ghost = node({
      key: 'i2c0:76',
      nodeName: 'bme280@76',
      label: 'bme280@76',
      compatible: 'bosch,bme280',
      presence: 'ghost',
    })
    expect(dockRowSecondary(ghost, 'devicetree')).toBe('bosch,bme280')
  })
})

describe('dockRowTitle', () => {
  it('joins node name and label with a middot, and keeps the virtio bus for power users', () => {
    const chip = node({
      key: 'virtio_i2c0:48',
      nodeName: 'tmp112@48',
      label: 'TMP112 temperature',
      busLabel: 'virtio_i2c0',
    })
    expect(dockRowTitle(chip)).toBe('tmp112@48 · TMP112 temperature · virtio_i2c0')
  })

  it('does not repeat the bus when the label already is the bus name', () => {
    const bus = node({
      key: 'virtio_i2c0',
      nodeName: 'virtio-i2c',
      label: 'I²C',
      busLabel: 'virtio_i2c0',
      deviceClass: 'i2c-bus',
    })
    expect(dockRowTitle(bus)).toBe('virtio-i2c · I²C · virtio_i2c0')
  })
})
