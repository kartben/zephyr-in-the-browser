#!/usr/bin/env bash
#
# Build a qemu-wasm emulator artifact set into public/qemu/.
#
#   tools/build-qemu-wasm.sh [target]        # target defaults to arm-softmmu
#
# Environment overrides:
#   QEMU_WASM_REPO     git remote            (default: ktock/qemu-wasm)
#   QEMU_WASM_REF      branch/tag/sha        (default: master)
#   QEMU_WASM_WORKDIR  scratch dir           (default: <repo>/.qemu-wasm-build)
#   JOBS               parallel make jobs    (default: container nproc)
#   PLATFORM           docker platform       (default: linux/amd64)
#
# This takes a long time — the dependency image alone compiles zlib, libffi,
# glib and pixman to WebAssembly. Both stages are cached: re-running skips the
# image build if it already exists, and skips the clone if the source is there.
#
# Upstream's README does not build cleanly as of 2026-07; every workaround
# applied by patch_upstream() below is annotated with why it is needed.

set -euo pipefail

TARGET="${1:-arm-softmmu}"
REPO="${QEMU_WASM_REPO:-https://github.com/ktock/qemu-wasm.git}"
REF="${QEMU_WASM_REF:-master}"
PLATFORM="${PLATFORM:-linux/amd64}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${QEMU_WASM_WORKDIR:-$ROOT/.qemu-wasm-build}"
SRC="$WORK/qemu-wasm"
DEST="$ROOT/public/qemu"

# arm-softmmu -> qemu-system-arm, aarch64-softmmu -> qemu-system-aarch64
BINARY="qemu-system-${TARGET%-softmmu}"
CONTAINER=build-qemu-wasm-$$
IMAGE=buildqemu

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------

fetch_source() {
  if [ -d "$SRC/.git" ]; then
    log "Reusing source at $SRC"
    return
  fi
  log "Cloning $REPO ($REF)"
  mkdir -p "$WORK"
  git clone --depth 1 --branch "$REF" "$REPO" "$SRC"
}

patch_upstream() {
  log "Applying upstream fixes"
  cd "$SRC"

  # (1) zlib.net keeps only the *current* release at its root path, so the
  #     pinned 1.3.1 tarball now 404s. `curl -Ls` cheerfully pipes the HTML
  #     error page into tar, which fails as "File format not recognized".
  if grep -q 'zlib.net/zlib-\$ZLIB_VERSION' Dockerfile; then
    sed -i.bak \
      's|https://zlib.net/zlib-\$ZLIB_VERSION.tar.xz|https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.xz|' \
      Dockerfile
    rm -f Dockerfile.bak
    echo "  - zlib source URL -> github releases"
  fi

  # (2) The QEMU source is mounted read-only into the build container, so meson
  #     cannot clone its subprojects itself ("Git command failed: git init ...").
  #     Pre-fetch every wrap-git subproject here, where the tree is writable.
  #     This bites arm-softmmu harder than upstream's tested targets: ARM
  #     machines require libfdt, so a missing dtc is a hard error rather than a
  #     skipped optional feature.
  cd "$SRC/subprojects"
  for wrap in *.wrap; do
    name="${wrap%.wrap}"
    [ "$(head -1 "$wrap" | tr -d '[]')" = "wrap-git" ] || continue
    [ -d "$name/.git" ] && continue
    url=$(awk -F' *= *' '/^url/{print $2}' "$wrap")
    rev=$(awk -F' *= *' '/^revision/{print $2}' "$wrap")
    echo "  - subproject $name @ ${rev:0:12}"
    rm -rf "$name"
    git clone -q "$url" "$name"
    git -C "$name" checkout -q "$rev"
  done

  # (3) Wraps declaring patch_directory get their meson.build from
  #     subprojects/packagefiles/. meson applies that overlay when it downloads
  #     the wrap itself; because step (2) cloned them by hand, do it here or
  #     meson fails with "Subproject exists but has no meson.build file".
  for wrap in *.wrap; do
    name="${wrap%.wrap}"
    patchdir=$(awk -F' *= *' '/^patch_directory/{print $2}' "$wrap")
    [ -n "$patchdir" ] && [ -d "packagefiles/$patchdir" ] || continue
    [ -f "$name/meson.build" ] && continue
    cp -R "packagefiles/$patchdir/." "$name/"
    echo "  - packagefiles overlay -> $name"
  done
}

# Patches in tools/qemu-patches/ add devices this project needs and upstream does
# not have. Applied after the bit-rot fixes so a failure here is unambiguous.
apply_local_patches() {
  local dir="$ROOT/tools/qemu-patches"
  [ -d "$dir" ] || return 0
  cd "$SRC"
  for patch in "$dir"/*.patch; do
    [ -e "$patch" ] || continue
    if git apply --reverse --check "$patch" >/dev/null 2>&1; then
      echo "  - already applied: $(basename "$patch")"
    elif git apply "$patch"; then
      echo "  - applied: $(basename "$patch")"
    else
      echo "  ! FAILED to apply $(basename "$patch") — the upstream tree has probably moved." >&2
      exit 1
    fi
  done
}

build_dep_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "Reusing dependency image '$IMAGE' (delete it to force a rebuild)"
    return
  fi
  log "Building dependency image (zlib, libffi, glib, pixman -> wasm; slow)"
  docker build --progress=plain --platform "$PLATFORM" -t "$IMAGE" - < "$SRC/Dockerfile"
}

build_qemu() {
  log "Starting build container"
  docker run --rm -d --platform "$PLATFORM" --name "$CONTAINER" \
    -v "$SRC:/qemu/:ro" "$IMAGE" >/dev/null

  local jobs="${JOBS:-$(docker exec "$CONTAINER" nproc)}"

  # Kept byte-for-byte in step with upstream's README except for --target-list.
  # The xterm-pty js-library is what makes Module.pty work; TTY and FS in
  # EXPORTED_RUNTIME_METHODS are what this app's loader needs.
  local cflags="-O3 -g -Wno-error=unused-command-line-argument -matomics -mbulk-memory"
  cflags="$cflags -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread"
  cflags="$cflags -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH"
  cflags="$cflags -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=mimalloc"
  cflags="$cflags --js-library=/build/node_modules/xterm-pty/emscripten-pty.js"
  cflags="$cflags -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js"

  log "Configuring for $TARGET"
  docker exec "$CONTAINER" emconfigure /qemu/configure \
    --static --target-list="$TARGET" --cpu=wasm32 --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs \
    --extra-cflags="$cflags" --extra-cxxflags="$cflags" \
    --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS"

  log "Building $BINARY with -j$jobs (this is the long part)"
  docker exec "$CONTAINER" emmake make -j "$jobs" "$BINARY"

  log "Installing artifacts into public/qemu/"
  mkdir -p "$DEST"
  # Emscripten's generated JS is named after the binary; this app expects out.js.
  docker cp "$CONTAINER:/build/$BINARY" "$DEST/out.js"
  docker cp "$CONTAINER:/build/$BINARY.wasm" "$DEST/$BINARY.wasm"
  # Only some Emscripten versions emit a separate pthread worker shim.
  if docker cp "$CONTAINER:/build/$BINARY.worker.js" "$DEST/$BINARY.worker.js" 2>/dev/null; then
    echo "  - $BINARY.worker.js"
  else
    echo "  - no $BINARY.worker.js emitted (fine on newer Emscripten)"
  fi
}

# ---------------------------------------------------------------------------

fetch_source
patch_upstream
apply_local_patches
build_dep_image
build_qemu

log "Done"
ls -la "$DEST"
cat <<EOF

Next:
  1. Point a board's qemuBinary at "$BINARY" in src/boards.ts.
  2. Build a guest image:  tools/build-zephyr-image.sh <board>
  3. Restart the dev server — the asset probe only scans public/qemu/ at startup.
EOF
