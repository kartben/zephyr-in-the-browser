#!/usr/bin/env bash
#
# Bundle the built emulator and guest images into release assets.
#
#   tools/package-emulator.sh [tag] [--emulator|--images|--all]
#
# Two assets rather than one, because the halves move at very different rates:
#
#   qemu-wasm-emulator.tar.gz   the wasm emulator — ~100 MB, rebuilt rarely
#   zephyr-images.tar.gz        the guest ELFs — small, rebuilt constantly
#
# Keeping them apart is what lets a Zephyr-only or page-only change deploy
# without rebuilding QEMU: package just the images, point IMAGES_RELEASE at the
# new tag, and leave EMULATOR_RELEASE where it is.
#
# Both tarballs are rooted at qemu/ and untar into public/, so together they
# reproduce exactly the layout tools/build-qemu-wasm.sh and
# tools/build-zephyr-image.sh produce. The artifacts are gitignored (GPLv2
# emulator binaries plus compiled guests), so a release asset is how they reach
# the Pages deploy without landing in git history.
#
# --emulator / --images package one half; the default is both. Only the half
# being packaged is checked for, so --images works fine in a tree that has never
# built the emulator.
#
# With a tag argument this also creates/updates the release and uploads. Without
# one it just writes the tarballs for you to upload by hand.

set -euo pipefail

TAG=""
WHAT=all

usage() {
  echo "usage: tools/package-emulator.sh [tag] [--emulator|--images|--all]" >&2
  exit 2
}

for arg in "$@"; do
  case "$arg" in
    --emulator) WHAT=emulator ;;
    --images)   WHAT=images ;;
    --all)      WHAT=all ;;
    -h|--help)  usage ;;
    -*)         echo "Unknown option: $arg" >&2; usage ;;
    *)
      [ -z "$TAG" ] || { echo "Only one tag may be given (got '$TAG' and '$arg')." >&2; usage; }
      TAG="$arg"
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/public/qemu"
EMULATOR_OUT="$ROOT/qemu-wasm-emulator.tar.gz"
IMAGES_OUT="$ROOT/zephyr-images.tar.gz"

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

want_emulator() { [ "$WHAT" = all ] || [ "$WHAT" = emulator ]; }
want_images()   { [ "$WHAT" = all ] || [ "$WHAT" = images ]; }

# Only pin the halves this run actually published; naming the other one would
# roll it back to this tag, which has no such asset.
deploy_flags() {
  local tag="$1" flags=""
  if want_emulator; then flags="-f emulator_release=$tag"; fi
  if want_images; then flags="${flags:+$flags }-f images_release=$tag"; fi
  echo "$flags"
}

ASSETS=()

# --- emulator ---------------------------------------------------------------

if want_emulator; then
  for binary in qemu-system-arm qemu-system-aarch64; do
    [ -f "$SRC/$binary.js" ] && [ -f "$SRC/$binary.wasm" ] \
      || { echo "Missing $binary artifacts — run tools/build-qemu-wasm.sh first." >&2; exit 1; }
  done

  # README.md is checked in; zephyr/ ships as its own asset. Everything else
  # under public/qemu/ is emulator build output.
  log "Packaging emulator: $(cd "$SRC" && ls | grep -Ev '^(README\.md|zephyr)$' | tr '\n' ' ')"
  tar czf "$EMULATOR_OUT" -C "$ROOT/public" \
    --exclude='qemu/README.md' --exclude='qemu/zephyr' --exclude='.DS_Store' qemu
  log "Wrote $EMULATOR_OUT ($(du -h "$EMULATOR_OUT" | cut -f1))"
  ASSETS+=("$EMULATOR_OUT")
fi

# --- guest images -----------------------------------------------------------

if want_images; then
  # Images live at zephyr/<board>/<app>.elf, so this has to recurse.
  [ -n "$(find "$SRC/zephyr" -name '*.elf' -print -quit 2>/dev/null)" ] \
    || { echo "No guest image — run tools/build-zephyr-image.sh first." >&2; exit 1; }
  for board in qemu_cortex_m3 qemu_cortex_a53; do
    [ -f "$SRC/zephyr/$board/gnss.elf" ] \
      || { echo "Missing $board GNSS image — run tools/build-zephyr-image.sh '$board' gnss." >&2; exit 1; }
  done

  log "Packaging guest images: $(cd "$SRC/zephyr" && ls | tr '\n' ' ')"
  tar czf "$IMAGES_OUT" -C "$ROOT/public" --exclude='.DS_Store' qemu/zephyr
  log "Wrote $IMAGES_OUT ($(du -h "$IMAGES_OUT" | cut -f1))"
  ASSETS+=("$IMAGES_OUT")
fi

# --- publish ----------------------------------------------------------------

if [ -z "$TAG" ]; then
  cat <<EOF

Upload them to a release, then deploy with that tag:

  gh release create <tag> ${ASSETS[*]} --title "<tag>" --notes "qemu-wasm + Zephyr guest"
EOF
  echo "  gh workflow run pages.yml $(deploy_flags '<tag>')"
  cat <<EOF

Or re-run this script with a tag to do the release step for you.
EOF
  exit 0
fi

log "Publishing release $TAG"
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" \
    --title "$TAG" \
    --notes "qemu-wasm emulator and Zephyr guest images.

Built with tools/build-qemu-wasm.sh and tools/build-zephyr-image.sh. The two
assets are pinned independently by the EMULATOR_RELEASE and IMAGES_RELEASE
repository variables, so guest images can be updated without a new emulator.

QEMU is GPLv2: corresponding source is qemu/qemu and ktock/qemu-wasm at the
revisions pinned by tools/build-qemu-wasm.sh, plus the patches under tools/ in
this repository."
fi

log "Done — deploy with:"
echo "  gh workflow run pages.yml $(deploy_flags "$TAG")"
