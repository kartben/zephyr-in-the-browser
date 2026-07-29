/**
 * Filesystem-agnostic tree shape, shared by every in-page browser.
 *
 * Two very different readers produce it — littlefs-js mounting SPI NOR bytes
 * (`littlefsBrowse.ts`) and a read-only FAT parser over a virtio-blk image
 * (`fatBrowse.ts`) — and one component renders it (`FsBrowser.tsx`). Keeping
 * the shape here is what lets that component be written once.
 */

export interface FsTreeFile {
  kind: 'file'
  name: string
  path: string
  size: number
  content: Uint8Array
}

export interface FsTreeDir {
  kind: 'dir'
  name: string
  path: string
  children: FsTreeNode[]
}

export type FsTreeNode = FsTreeFile | FsTreeDir

export interface FsBrowseResult {
  /** One line of medium-specific detail for the header, e.g. geometry. */
  summary: string
  files: Array<{ path: string; size: number; content: Uint8Array }>
  root: FsTreeDir
  /** Set when the volume mounted but listing hit an error. */
  error?: string
}

/** Decode file bytes as UTF-8 when printable; otherwise hex. */
export function previewFileContent(
  bytes: Uint8Array,
  max = 512,
): { kind: 'text' | 'hex'; text: string } {
  const slice = bytes.length > max ? bytes.subarray(0, max) : bytes
  let printable = true
  for (let i = 0; i < slice.length; i++) {
    const b = slice[i]!
    if (b === 9 || b === 10 || b === 13) continue
    if (b < 32 || b > 126) {
      printable = false
      break
    }
  }
  if (printable) {
    const text = new TextDecoder().decode(slice) + (bytes.length > max ? '…' : '')
    return { kind: 'text', text }
  }
  let hex = ''
  for (let i = 0; i < slice.length; i++) {
    if (i && i % 16 === 0) hex += '\n'
    else if (i) hex += ' '
    hex += slice[i]!.toString(16).padStart(2, '0')
  }
  if (bytes.length > max) hex += '\n…'
  return { kind: 'hex', text: hex }
}
