/**
 * App version from package.json, injected at build time by vite.config.ts.
 * During `npm run typecheck` / vitest the vite plugin still runs, so this is
 * always defined; the string fallback is only for tooling that skips Vite.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
