import { defineConfig } from 'vite'

/**
 * Bundles the Electron main process into dist-electron/main.js.
 *
 * The renderer is a normal `vite build` into dist/. Electron is left external:
 * the binary provides it. Everything else we write is inlined, so the packaged
 * app does not need the frontend's node_modules.
 */
export default defineConfig({
  // public/ belongs to the renderer build (dist/). Copying it here would
  // duplicate the guest images into the main-process bundle.
  publicDir: false,
  build: {
    ssr: 'electron/main.ts',
    outDir: 'dist-electron',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: 'node22',
    rollupOptions: {
      external: ['electron'],
      output: {
        format: 'es',
        entryFileNames: 'main.js',
      },
    },
  },
  ssr: {
    external: ['electron'],
  },
})
