#!/usr/bin/env bash
#
# Build a qemu-wasm emulator artifact set into public/qemu/.
#
#   tools/build-qemu-wasm.sh [target]        # target defaults to all
#                                             (arm-softmmu + aarch64-softmmu)
#
# Environment overrides:
#   QEMU_REPO      git remote            (default: qemu/qemu)
#   QEMU_REF       tag/branch/sha        (default: v10.1.0)
#   QEMU_WORKDIR   scratch dir           (default: <repo>/.qemu-wasm-build)
#   JOBS           parallel build jobs   (default: container nproc)
#   PLATFORM       docker platform       (default: linux/amd64)
#
# Builds *upstream* QEMU. Emscripten support landed in 10.1, contributed by the
# same author as the ktock/qemu-wasm fork this project used to build, so the
# fork is no longer needed. Upstream is TCI-only — the TCG→Wasm JIT is not
# upstreamed — which is why --enable-tcg-interpreter is mandatory below. The
# resulting binary is substantially smaller than the old fork build.
#
# The dependency image (glib, pixman, zlib, libffi cross-compiled to Wasm) is
# built from tools/Dockerfile.deps and is the slow part; it is cached, so
# re-runs skip it.

set -euo pipefail

TARGET_ARG="${1:-all}"
REPO_URL="${QEMU_REPO:-https://github.com/qemu/qemu.git}"
REF="${QEMU_REF:-v10.1.0}"
PLATFORM="${PLATFORM:-linux/amd64}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${QEMU_WORKDIR:-$ROOT/.qemu-wasm-build}"
SRC="$WORK/qemu"
DEST="$ROOT/public/qemu"

CONTAINER=build-qemu-wasm-$$
IMAGE=qemu-wasm-deps

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------

fetch_source() {
  if [ -d "$SRC/.git" ]; then
    log "Reusing source at $SRC"
    return
  fi
  log "Cloning $REPO_URL ($REF)"
  mkdir -p "$WORK"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$SRC"
}

# The QEMU source is mounted read-only into the build container, so meson cannot
# clone its subprojects itself ("Git command failed: git init ..."). Pre-fetch
# them here, where the tree is writable. This bites arm-softmmu harder than
# other targets: ARM machines require libfdt, so a missing dtc is a hard error
# rather than a skipped optional feature.
fetch_subprojects() {
  log "Pre-fetching meson subprojects"
  cd "$SRC/subprojects"
  for wrap in *.wrap; do
    name="${wrap%.wrap}"
    [ "$(head -1 "$wrap" | tr -d '[]')" = "wrap-git" ] || continue
    if [ ! -d "$name/.git" ]; then
      url=$(awk -F' *= *' '/^url/{print $2}' "$wrap")
      rev=$(awk -F' *= *' '/^revision/{print $2}' "$wrap")
      echo "  - $name @ ${rev:0:12}"
      rm -rf "$name"
      git clone -q "$url" "$name"
      git -C "$name" checkout -q "$rev"
    fi
    # Wraps declaring patch_directory get their meson.build from
    # subprojects/packagefiles/, an overlay meson applies only when it downloads
    # the wrap itself. Pre-fetching by hand skips it.
    patchdir=$(awk -F' *= *' '/^patch_directory/{print $2}' "$wrap")
    if [ -n "$patchdir" ] && [ -d "packagefiles/$patchdir" ] && [ ! -f "$name/meson.build" ]; then
      cp -R "packagefiles/$patchdir/." "$name/"
      echo "    + packagefiles overlay"
    fi
  done
}

# Patches in tools/qemu-patches/ add the browser sensor and ramfb bridges and
# put xterm-pty on the link line.
apply_local_patches() {
  local dir="$ROOT/tools/qemu-patches"
  [ -d "$dir" ] || return 0
  log "Applying local patches"
  cd "$SRC"
  for patch in "$dir"/*.patch; do
    [ -e "$patch" ] || continue
    if git apply --reverse --check "$patch" >/dev/null 2>&1; then
      echo "  - already applied: $(basename "$patch")"
    elif git apply "$patch"; then
      echo "  - applied: $(basename "$patch")"
    else
      echo "  ! FAILED to apply $(basename "$patch") — QEMU $REF has probably moved." >&2
      exit 1
    fi
  done
}

build_dep_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "Reusing dependency image '$IMAGE' (delete it to force a rebuild)"
    return
  fi
  log "Building dependency image (glib, pixman, zlib, libffi -> wasm; slow)"
  docker build --progress=plain --platform "$PLATFORM" -t "$IMAGE" - < "$ROOT/tools/Dockerfile.deps"
}

build_qemu() {
  local target="$1"
  local binary="qemu-system-${target%-softmmu}"

  log "Starting build container"
  docker run --rm -d --platform "$PLATFORM" --name "$CONTAINER" \
    -v "$SRC:/qemu/:ro" "$IMAGE" >/dev/null

  local jobs="${JOBS:-$(docker exec "$CONTAINER" nproc)}"

  # configure auto-detects Emscripten and pulls in configs/meson/emscripten.txt,
  # which already carries ASYNCIFY, PROXY_TO_PTHREAD, EXPORT_ES6 and friends —
  # so unlike the old fork build there is no wall of flags to keep in sync.
  #   --with-coroutine=wasm      upstream has a real wasm backend (not 'fiber')
  #   --enable-tcg-interpreter   mandatory: no TCG→Wasm JIT upstream
  log "Configuring for $target"
  docker exec "$CONTAINER" emconfigure /qemu/configure \
    --static --target-list="$target" --cross-prefix= \
    --without-default-features --enable-system \
    --with-coroutine=wasm --enable-tcg-interpreter

  # Note the target is "<binary>.js", not "<binary>" as in the fork.
  log "Building $binary.js with -j$jobs (this is the long part)"
  docker exec "$CONTAINER" sh -c "cd /build && ninja -j $jobs $binary.js"

  log "Installing artifacts into public/qemu/"
  mkdir -p "$DEST"
  docker cp "$CONTAINER:/build/$binary.js" "$DEST/$binary.js"
  docker cp "$CONTAINER:/build/$binary.wasm" "$DEST/$binary.wasm"
  # The standalone ramfb device registers this tiny option ROM even though the
  # browser reads its mapped pixels directly instead of using a QEMU frontend.
  if [ "$target" = "aarch64-softmmu" ]; then
    cp "$SRC/pc-bios/vgabios-ramfb.bin" "$DEST/vgabios-ramfb.bin"
    cp "$SRC/pc-bios/efi-virtio.rom" "$DEST/efi-virtio.rom"
  fi
  # Only some Emscripten versions emit a separate pthread worker shim.
  if docker cp "$CONTAINER:/build/$binary.worker.js" "$DEST/$binary.worker.js" 2>/dev/null; then
    echo "  - $binary.worker.js"
  else
    echo "  - no $binary.worker.js emitted (fine on newer Emscripten)"
  fi

  docker rm -f "$CONTAINER" >/dev/null
}

# ---------------------------------------------------------------------------

fetch_source
fetch_subprojects
apply_local_patches
build_dep_image
if [ "$TARGET_ARG" = "all" ]; then
  build_qemu arm-softmmu
  build_qemu aarch64-softmmu
else
  build_qemu "$TARGET_ARG"
fi

log "Done"
ls -la "$DEST"
cat <<EOF

Next:
  1. Build a guest image:  tools/build-zephyr-image.sh
  2. Restart the dev server — public/qemu/ is only scanned at startup.
EOF
