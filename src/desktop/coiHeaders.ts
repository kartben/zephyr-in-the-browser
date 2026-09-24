/**
 * Response headers that make a document cross-origin isolated.
 *
 * SharedArrayBuffer exists only in that state. xterm-pty blocks on it for
 * stdin, and the qemu-wasm build is linked with pthreads, so without these
 * two headers the guest hangs on the first read. The dev server, `vite
 * preview`, and the desktop app's loopback server all send this same pair.
 *
 * See https://web.dev/coop-coep/ and public/qemu/README.md.
 */
export const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const
