/**
 * Browse a LittleFS v2 image from SPI NOR bytes.
 *
 * Uses [`partitions-tool-esp/littlefs`](https://www.npmjs.com/package/partitions-tool-esp)
 * (pure TypeScript parser) rather than a hand-rolled on-disk format reader.
 * Verified against images produced by real littlefs (v2.x).
 */

import { parse, type LittleFSParsedFile, type LittleFSSuperblock } from 'partitions-tool-esp/littlefs'

export interface LittlefsTreeFile {
  kind: 'file'
  name: string
  path: string
  size: number
  content: Uint8Array
}

export interface LittlefsTreeDir {
  kind: 'dir'
  name: string
  path: string
  children: LittlefsTreeNode[]
}

export type LittlefsTreeNode = LittlefsTreeFile | LittlefsTreeDir

export interface LittlefsBrowseResult {
  superblock: LittleFSSuperblock
  files: LittleFSParsedFile[]
  root: LittlefsTreeDir
}

/** True when the image looks erased (no LittleFS yet). */
export function isBlankFlash(image: Uint8Array, erased = 0xff): boolean {
  // Sample a few blocks — full 1 MiB scan is wasteful for the empty case.
  const step = Math.max(1, Math.floor(image.length / 64))
  for (let i = 0; i < image.length; i += step) {
    if (image[i] !== erased) return false
  }
  // Confirm edges of first two erase blocks (superblock pair lives here).
  for (let i = 0; i < Math.min(image.length, 8192); i++) {
    if (image[i] !== erased) return false
  }
  return true
}

/**
 * Mount-and-list a LittleFS image. Returns `null` when the flash is blank or
 * the image is not a recognisable littlefs v2 filesystem.
 */
export function browseLittlefs(
  image: Uint8Array,
  opts: { blockSize?: number } = {},
): LittlefsBrowseResult | null {
  if (image.length === 0 || isBlankFlash(image)) return null
  try {
    const parsed = parse(image, { blockSize: opts.blockSize ?? 4096 })
    return {
      superblock: parsed.superblock,
      files: parsed.files,
      root: buildTree(parsed.files),
    }
  } catch {
    return null
  }
}

function buildTree(files: LittleFSParsedFile[]): LittlefsTreeDir {
  const root: LittlefsTreeDir = { kind: 'dir', name: '/', path: '/', children: [] }

  const ensureDir = (parts: string[]): LittlefsTreeDir => {
    let dir = root
    let path = ''
    for (const part of parts) {
      path += `/${part}`
      let child = dir.children.find((c): c is LittlefsTreeDir => c.kind === 'dir' && c.name === part)
      if (!child) {
        child = { kind: 'dir', name: part, path, children: [] }
        dir.children.push(child)
      }
      dir = child
    }
    return dir
  }

  for (const file of files) {
    const segs = file.path.split('/').filter(Boolean)
    if (segs.length === 0) continue
    const name = segs[segs.length - 1]!
    const parent = ensureDir(segs.slice(0, -1))
    parent.children.push({
      kind: 'file',
      name,
      path: file.path.startsWith('/') ? file.path : `/${file.path}`,
      size: file.size,
      content: file.content,
    })
  }

  const sortNode = (node: LittlefsTreeDir) => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const c of node.children) if (c.kind === 'dir') sortNode(c)
  }
  sortNode(root)
  return root
}

/** Decode file bytes as UTF-8 when printable; otherwise hex. */
export function previewFileContent(bytes: Uint8Array, max = 512): { kind: 'text' | 'hex'; text: string } {
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
