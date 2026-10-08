import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { tourTraits } from './src/tours/traits'

// Standalone test config so `vite build` / `tsc --noEmit` stay untouched.
export default defineConfig({
  // The page's tour catalog reads each tour's needs through it (src/tours/traits.ts).
  plugins: [tourTraits()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // .tsx too, so a component's rendered output can be asserted against —
    // HexView renders the bytes a user reads, which is worth pinning.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
