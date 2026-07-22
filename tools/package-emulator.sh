#!/usr/bin/env bash
#
# Bundle the built emulator and guest images into a single release asset.
#
#   tools/package-emulator.sh [tag]
#
# The artifacts are gitignored (GPLv2 emulator binaries plus compiled guests), so
# a release asset is how they reach the Pages deploy without landing in git
# history. One tarball rather than loose files because release assets are flat
# and public/qemu/ has a zephyr/ subdirectory.
#
# With a tag argument this also creates/updates the release and uploads. Without
# one it just writes the tarball for you to upload by hand.

set -euo pipefail

TAG="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/public/qemu"
OUT="$ROOT/qemu-wasm-artifacts.tar.gz"

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

for binary in qemu-system-arm qemu-system-aarch64; do
  [ -f "$SRC/$binary.js" ] && [ -f "$SRC/$binary.wasm" ] \
    || { echo "Missing $binary artifacts — run tools/build-qemu-wasm.sh first." >&2; exit 1; }
done
# Images live at zephyr/<board>/<app>.elf, so this has to recurse.
[ -n "$(find "$SRC/zephyr" -name '*.elf' -print -quit 2>/dev/null)" ] \
  || { echo "No guest image — run tools/build-zephyr-image.sh first." >&2; exit 1; }

# README.md is checked in; everything else here is a build output.
log "Packaging $(cd "$SRC" && ls | grep -v '^README.md$' | tr '\n' ' ')"
tar czf "$OUT" -C "$ROOT/public" --exclude='qemu/README.md' --exclude='.DS_Store' qemu

log "Wrote $OUT ($(du -h "$OUT" | cut -f1))"

if [ -z "$TAG" ]; then
  cat <<EOF

Upload it to a release, then deploy with that tag:

  gh release create <tag> "$OUT" --title "<tag>" --notes "qemu-wasm + Zephyr guest"
  gh workflow run pages.yml -f emulator_release=<tag>

Or re-run this script with a tag to do the release step for you.
EOF
  exit 0
fi

log "Publishing release $TAG"
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$OUT" --clobber
else
  gh release create "$TAG" "$OUT" \
    --title "$TAG" \
    --notes "qemu-wasm emulator and Zephyr guest images.

Built with tools/build-qemu-wasm.sh and tools/build-zephyr-image.sh.
QEMU is GPLv2: corresponding source is qemu/qemu at the tag pinned by
tools/build-qemu-wasm.sh, plus the patches in tools/qemu-patches/ in this
repository."
fi

log "Done — deploy with: gh workflow run pages.yml -f emulator_release=$TAG"
