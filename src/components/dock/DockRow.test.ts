import { describe, expect, it } from 'vitest'
import { dockRowSecondary } from './DockRow'
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
      crumb: 'virtio_i2c0 · 0x48',
    })
    expect(dockRowSecondary(chip, 'classes')).toBe('virtio_i2c0 · 0x48')
  })

  it('shows the friendly label in the device-tree view, not the compatible', () => {
    const chip = node({
      key: 'virtio_i2c0:48',
      nodeName: 'tmp112@48',
      label: 'TMP112 temperature',
      compatible: 'ti,tmp112',
      partId: 'tmp112',
      crumb: 'virtio_i2c0 · 0x48',
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
