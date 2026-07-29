/**
 * LittleFS adapter for {@link FsBrowserButton}.
 *
 * Mounts the W25Q image with real littlefs via Dreagonmon littlefs-js
 * (`src/lib/littlefsBrowse.ts`); the dialog, tree and preview are the shared
 * ones in `FsBrowser.tsx`.
 */

import { useCallback, useMemo } from 'react'
import { FsBrowserButton } from '@/components/FsBrowser'
import { browseLittlefs } from '@/lib/littlefsBrowse'
import type { FsBrowseResult } from '@/lib/fsTree'
import type { SpiFlashChip } from '@/virtio/devices/flash/model'

export function LittlefsBrowserButton({ chip }: { chip: SpiFlashChip }) {
  const browse = useCallback(async (): Promise<FsBrowseResult | null> => {
    const result = await browseLittlefs(chip.memory, { blockSize: chip.decl.sectorSize })
    // null means the flash is still erased — there is no volume yet, which the
    // shared dialog renders as its `empty` label rather than an empty tree.
    if (!result) return null
    const { superblock } = result
    return {
      ...result,
      summary: `${superblock.blockCount} × ${superblock.blockSize} B blocks · erase ${chip.decl.sectorSize} B`,
    }
  }, [chip])

  // The chip owns its bytes, so it can push instead of being polled.
  const subscribe = useCallback((onChange: () => void) => chip.subscribe(onChange), [chip])

  const labels = useMemo(
    () => ({
      title: `${chip.name} · /lfs`,
      description: 'LittleFS contents on this SPI flash',
      loading: 'Mounting LittleFS…',
      empty:
        'No LittleFS image yet — boot a sample that formats and mounts the partition, then reopen this view.',
      failed: 'Could not mount LittleFS from this flash image.',
      mountedEmpty: 'Mounted, but empty.',
    }),
    [chip.name],
  )

  return (
    <FsBrowserButton
      labels={labels}
      browse={browse}
      subscribe={subscribe}
      title="Browse LittleFS on this flash"
    />
  )
}
