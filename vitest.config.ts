import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Standalone test config so `vite build` / `tsc --noEmit` stay untouched.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
