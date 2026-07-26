/**
 * Ambient types for the vendored Dreagonmon littlefs-js build (lfs_js.js).
 * Keep in sync with the runtime exports; this is intentionally minimal.
 */

declare module '@/vendor/littlefs-js/lfs_js.js' {
  export const LFSModule: {
    HEAPU8: Uint8Array
  }

  export const LFS_ERR_OK: number
  export const LFS_ERR_IO: number
  export const LFS_ERR_CORRUPT: number
  export const LFS_ERR_NOENT: number
  export const LFS_TYPE_REG: number
  export const LFS_TYPE_DIR: number
  export const LFS_O_RDONLY: number
  export const LFS_O_WRONLY: number
  export const LFS_O_RDWR: number
  export const LFS_O_CREAT: number
  export const LFS_O_EXCL: number
  export const LFS_O_TRUNC: number
  export const LFS_O_APPEND: number

  export class BlockDevice {
    read_size: number
    prog_size: number
    block_size: number
    block_count: number
    read(block: number, off: number, buffer: number, size: number): number | Promise<number>
    prog(block: number, off: number, buffer: number, size: number): number | Promise<number>
    erase(block: number): number | Promise<number>
    sync(): number | Promise<number>
  }

  export class MemoryBlockDevice extends BlockDevice {
    constructor(block_size: number, block_count: number)
    _storage: Array<Uint8Array | undefined>
  }

  export type LFSInfo = { type: number; size: number; name: string }

  export class LFSFile {
    err?: number
    close(): Promise<number>
    sync(): Promise<number>
    read(size?: number): Promise<Uint8Array | number>
    write(data: Uint8Array): Promise<number>
    size(): Promise<number>
  }

  export class LFSDir {
    err?: number
    close(): Promise<number>
    read(): Promise<LFSInfo | null | number>
  }

  export class LFS {
    constructor(bd: BlockDevice, block_cycles: number)
    read_size: number
    prog_size: number
    block_size: number
    block_count: number
    cache_size?: number
    lookahead_size?: number
    format(): Promise<number>
    mount(): Promise<number>
    unmount(): Promise<number>
    open(name: string, flags: number): Promise<LFSFile | number>
    mkdir(path: string): Promise<number>
    opendir(name: string): Promise<LFSDir | number>
    stat(path: string): Promise<LFSInfo | number>
  }
}
