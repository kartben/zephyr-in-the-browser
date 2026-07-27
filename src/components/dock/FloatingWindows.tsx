/**
 * The popped-out devices: every dock row whose `windowed` flag is set becomes
 * a floating PanelFrame window over the stage, hosting the exact same body its
 * row would. Geometry persists per device key (lib/panelLayout.ts); closing a
 * window returns the body to the dock. DOM order is inventory order — all
 * windows share z-40, below the z-50 overlays.
 */

import { useSyncExternalStore } from 'react'
import { PanelFrame } from '@/components/PanelFrame'
import { DeviceBody, deviceIcon } from '@/components/dock/deviceBodies'
import type { DeviceNode } from '@/deviceTopology'
import { useDeviceTree } from '@/hooks/useDeviceTree'
import { getState, setWindowed, subscribe } from '@/lib/dockStore'

/**
 * Seed size for a popped-out device. Hex/flash carry a dump (and for NOR, a
 * sector map); they need more room than a sensor card so the bottom chrome —
 * hints, legend, last hex rows — is not scrolled off the first look.
 */
function windowSeed(node: DeviceNode): { width: number; height?: number } {
  if (node.body === 'spi-flash') return { width: 32, height: 40 }
  if (node.body === 'memory') return { width: 28, height: 34 }
  if (node.body === 'net') return { width: 21 }
  return { width: 19 }
}

export function FloatingWindows({ boardId }: { boardId: string }) {
  const state = useSyncExternalStore(subscribe, getState, getState)
  const inventory = useDeviceTree(boardId)

  const windowed = inventory.nodes.filter(
    (node) => node.presence === 'interactive' && state.devices[node.key]?.windowed === true,
  )

  return (
    <>
      {windowed.map((node) => {
        const seed = windowSeed(node)
        return (
          <PanelFrame
            key={node.key}
            id={node.key}
            title={node.label}
            icon={deviceIcon(node)}
            dockedWidth={seed.width}
            seedHeight={seed.height}
            windowed={{ onClose: () => setWindowed(node.key, false) }}
            status={
              (node.crumb ?? node.compatible) && (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {node.crumb ?? node.compatible}
                </span>
              )
            }
          >
            <DeviceBody node={node} variant="window" />
          </PanelFrame>
        )
      })}
    </>
  )
}
