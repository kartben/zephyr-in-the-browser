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

/** The hex dump wants width; the rest are fine at the default. */
function windowWidth(node: DeviceNode): number {
  if (node.body === 'memory') return 27
  if (node.body === 'net') return 21
  return 19
}

export function FloatingWindows({ boardId }: { boardId: string }) {
  const state = useSyncExternalStore(subscribe, getState, getState)
  const inventory = useDeviceTree(boardId)

  const windowed = inventory.nodes.filter(
    (node) => node.presence === 'interactive' && state.devices[node.key]?.windowed === true,
  )

  return (
    <>
      {windowed.map((node) => (
        <PanelFrame
          key={node.key}
          id={node.key}
          title={node.label}
          icon={deviceIcon(node)}
          dockedWidth={windowWidth(node)}
          windowed={{ onClose: () => setWindowed(node.key, false) }}
          status={
            (node.crumb ?? node.compatible) && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {node.crumb ?? node.compatible}
              </span>
            )
          }
        >
          <DeviceBody node={node} />
        </PanelFrame>
      ))}
    </>
  )
}
