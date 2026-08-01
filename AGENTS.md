# Zephyr in the Browser

A Vite + React + TypeScript single-page app that runs the Zephyr RTOS in the
browser. Most of the interesting logic (network stack, virtio device models,
dock UI) is TypeScript with a large vitest suite. See `README.md` for the
product overview and `docs/` for emulator internals.

## Changelog

Notable user-facing changes go in `CHANGELOG.md` under `## Unreleased`. Keep
entries short (about 10 words). Only note important new capabilities on the
page, or fixes for bugs that shipped in a **previous** release. Skip CI,
release workflows, and other maintainer plumbing. After editing, run
`npm run gen:changelog` so `src/changelog.ts` stays in sync with the help
dialog. Full guidelines: `CLAUDE.md`.

App semver is `package.json`'s `X.Y.Z-dev`; cut a release with the **Release**
workflow. That is separate from `tools/release.sh`'s `vN` emulator/image tags.

## Cursor Cloud specific instructions

- This repo is frontend-only for day-to-day development. The dev server boots a
  **mock backend** (a fake shell that echoes input and answers a few commands),
  so the UI works end-to-end without building the emulator. Standard commands
  live in `package.json` (`dev`, `typecheck`, `test`, `build`).
- There is no ESLint/lint script; `npm run typecheck` (`tsc --noEmit`) is the
  lint-equivalent gate, matching CI (`.github/workflows/ci.yml`, which runs
  `typecheck` + `test`).
- Run the dev server with a fixed port so it's predictable:
  `npm run dev -- --port 5173 --strictPort`, then open http://localhost:5173.
- Booting **real Zephyr** (instead of the mock) requires the slow, containerized
  builds in `tools/build-qemu-wasm.sh` (Emscripten/Docker) and
  `tools/build-zephyr-image.sh`. These are NOT part of normal setup and are not
  needed to run/test the app; only run them when specifically working on the
  emulator. See `public/qemu/README.md`.
