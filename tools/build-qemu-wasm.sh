#!/usr/bin/env bash
#
# Build a qemu-wasm emulator artifact set into public/qemu/.
#
#   tools/build-qemu-wasm.sh [target]        # target defaults to all
#                                             (arm-softmmu + aarch64-softmmu;
#                                              pass riscv32-softmmu explicitly)
#
# Environment overrides:
#   QEMU_REPO             upstream git remote      (default: qemu/qemu)
#   QEMU_REF              upstream tag/branch/sha  (default: v10.1.0)
#   QEMU_JIT_REPO         JIT git remote           (default: ktock/qemu-wasm)
#   QEMU_JIT_REF          JIT commit               (pinned below)
#   QEMU_AARCH64_ACCEL    jit or tci                (default: jit)
#   QEMU_WORKDIR          scratch dir               (default: <repo>/.qemu-wasm-build)
#   JOBS                  parallel build jobs       (default: container nproc)
#   PLATFORM              docker platform           (default: linux/amd64)
#
# The Cortex-M and RISC-V artifacts build upstream QEMU with its TCI
# interpreter. The Cortex-A53 artifact defaults to ktock/qemu-wasm's
# experimental wasm32 TCG backend: it starts blocks in TCI, then compiles hot
# blocks into small Wasm modules. The JIT is not upstream QEMU and previously
# miscompiled Cortex-M timer paths, so it is deliberately limited to the
# AArch64 display machine. Set QEMU_AARCH64_ACCEL=tci for the slower
# all-upstream fallback. RISC-V uses tools/qemu-riscv-patches/ (not the ARM
# Stellaris series) so machine wiring lands in hw/riscv/virt.c.
#
# The dependency image (glib, pixman, zlib, libffi cross-compiled to Wasm) is
# built from tools/Dockerfile.deps and is the slow part; it is cached, so
# re-runs skip it. `all` still builds only arm + aarch64 — riscv32 is opt-in
# until its artifact size and release packaging are settled (see
# docs/riscv32-plan.md).

set -euo pipefail

TARGET_ARG="${1:-all}"
REPO_URL="${QEMU_REPO:-https://github.com/qemu/qemu.git}"
REF="${QEMU_REF:-v10.1.0}"
JIT_REPO_URL="${QEMU_JIT_REPO:-https://github.com/ktock/qemu-wasm.git}"
JIT_REF="${QEMU_JIT_REF:-36a7f4334e9e08691d7496809a5d06b23de22e26}"
AARCH64_ACCEL="${QEMU_AARCH64_ACCEL:-jit}"
PLATFORM="${PLATFORM:-linux/amd64}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${QEMU_WORKDIR:-$ROOT/.qemu-wasm-build}"
TCI_SRC="$WORK/qemu"
JIT_SRC="$WORK/qemu-jit"
DEST="$ROOT/public/qemu"

CONTAINER=build-qemu-wasm-$$
IMAGE=qemu-wasm-deps

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------

fetch_source() {
  local src="$1" repo_url="$2" ref="$3"

  if [ -d "$src/.git" ]; then
    # A previous run can leave a .git with an incomplete working tree (interrupted
    # clone, manual cleanup, sparse checkout). subprojects/ is required before
    # we can pre-fetch meson wraps — restore tracked files if it is gone.
    if [ ! -d "$src/subprojects" ]; then
      log "Repairing incomplete source at $src (missing subprojects/)"
      if git -C "$src" rev-parse --verify HEAD >/dev/null 2>&1; then
        git -C "$src" checkout -q --force -- . || true
      fi
    fi
    if [ -d "$src/subprojects" ]; then
      log "Reusing source at $src"
      return
    fi
    log "Could not repair $src — removing and re-cloning"
    rm -rf "$src"
  fi
  log "Cloning $repo_url ($ref)"
  mkdir -p "$WORK"
  git init -q "$src"
  git -C "$src" remote add origin "$repo_url"
  git -C "$src" fetch -q --depth 1 origin "$ref"
  git -C "$src" checkout -q --detach FETCH_HEAD
  if [ ! -d "$src/subprojects" ]; then
    echo "error: cloned $repo_url@$ref but subprojects/ is still missing." >&2
    exit 1
  fi
}

# The QEMU source is mounted read-only into the build container, so meson cannot
# clone its subprojects itself ("Git command failed: git init ..."). Pre-fetch
# them here, where the tree is writable. This bites arm-softmmu harder than
# other targets: ARM machines require libfdt, so a missing dtc is a hard error
# rather than a skipped optional feature.
fetch_subprojects() {
  local src="$1"
  log "Pre-fetching meson subprojects"
  if [ ! -d "$src/subprojects" ]; then
    echo "error: $src/subprojects missing — QEMU checkout is incomplete." >&2
    echo "Remove $src and re-run, or: git -C \"$src\" checkout --force -- ." >&2
    exit 1
  fi
  # shellcheck disable=SC2164
  cd "$src/subprojects"
  shopt -s nullglob
  local wraps=(*.wrap)
  shopt -u nullglob
  if [ ${#wraps[@]} -eq 0 ]; then
    echo "error: no *.wrap files in $src/subprojects" >&2
    exit 1
  fi
  local wrap name url rev patchdir
  for wrap in "${wraps[@]}"; do
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

# The target-specific patch directory adds the required browser bridges and
# puts xterm-pty on the link line.
#
# The series is re-applied to a pristine tree every run. Patches are applied to
# the working tree and never committed, so a reused source directory still
# carries the last run's series — and asking "is this one already applied?" per
# patch stops working the moment two of them touch the same lines, which the
# xterm-pty and link-optimisation patches both do to c_link_args. Restoring
# first makes the question unnecessary, and makes the failure message below mean
# what it says.
#
# Restoring means two things, because patches both modify and create files:
# `git checkout` puts the tracked ones back, and the files the series *added*
# have to be removed by hand — they are untracked, so checkout leaves them, and
# `git apply` refuses to create a file that already exists. Those paths are
# taken from the patches themselves rather than from a list kept in step with
# them, and nothing else is touched: `git clean` here would take the pre-fetched
# subprojects/ trees and the packagefiles overlay with it.
#
# Hand-edits to the QEMU source do not survive: experiment by editing the patch,
# not the checkout.
apply_local_patches() {
  local src="$1" dir="$2" ref="$3"
  [ -d "$dir" ] || return 0
  log "Applying local patches (restoring the tree to $ref first)"
  cd "$src"
  git checkout -q --force -- .
  awk '/^new file mode/ { new = 1 }
       /^\+\+\+ b\// { if (new) print substr($0, 7); new = 0 }' "$dir"/*.patch |
    while IFS= read -r created; do rm -f "$created"; done
  for patch in "$dir"/*.patch; do
    [ -e "$patch" ] || continue
    if git apply "$patch"; then
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
  local src="$2"
  local accel="$3"
  local binary="qemu-system-${target%-softmmu}"

  log "Starting build container"
  docker run --rm -d --platform "$PLATFORM" --name "$CONTAINER" \
    -v "$src:/qemu/:ro" "$IMAGE" >/dev/null

  local jobs="${JOBS:-$(docker exec "$CONTAINER" nproc)}"

  # configure auto-detects Emscripten and pulls in configs/meson/emscripten.txt,
  # which already carries ASYNCIFY, PROXY_TO_PTHREAD, EXPORT_ES6 and friends —
  # so unlike the old fork build there is no wall of flags to keep in sync.
  #   --with-coroutine=wasm      upstream has a real wasm backend (not 'fiber')
  #   --enable-tcg-interpreter   mandatory for upstream; omitted for the
  #                              experimental native wasm32 TCG backend
  #   --with-devices-<arch>      configs/devices/<target>/browser.mak instead of
  #                              default.mak: every ARM board QEMU ships is
  #                              otherwise compiled in, and this boots two.
  #                              Deliberately *not* --without-default-devices —
  #                              see the header of either .mak.
  local devices="--with-devices-${target%-softmmu}=browser"
  log "Configuring for $target ($accel)"
  if [ "$accel" = "jit" ]; then
    docker exec "$CONTAINER" emconfigure /qemu/configure \
      --static --target-list="$target" --cross-prefix= \
      --without-default-features --enable-system "$devices" \
      --with-coroutine=wasm
  else
    docker exec "$CONTAINER" emconfigure /qemu/configure \
      --static --target-list="$target" --cross-prefix= \
      --without-default-features --enable-system "$devices" \
      --with-coroutine=wasm --enable-tcg-interpreter
  fi

  # Note the target is "<binary>.js", not "<binary>" as in the fork.
  log "Building $binary.js with -j$jobs (this is the long part)"
  docker exec "$CONTAINER" sh -c "cd /build && ninja -j $jobs $binary.js"

  log "Installing artifacts into public/qemu/"
  mkdir -p "$DEST"
  docker cp "$CONTAINER:/build/$binary.js" "$DEST/$binary.js"
  docker cp "$CONTAINER:/build/$binary.wasm" "$DEST/$binary.wasm"
  # The standalone ramfb device registers this tiny option ROM even though the
  # browser reads its mapped pixels directly instead of using a QEMU frontend.
  # Both AArch64 and RISC-V virt boards may use -device ramfb.
  if [ "$target" = "aarch64-softmmu" ] || [ "$target" = "riscv32-softmmu" ]; then
    cp "$src/pc-bios/vgabios-ramfb.bin" "$DEST/vgabios-ramfb.bin"
    cp "$src/pc-bios/efi-virtio.rom" "$DEST/efi-virtio.rom"
  fi
  # Only some Emscripten versions emit a separate pthread worker shim.
  if docker cp "$CONTAINER:/build/$binary.worker.js" "$DEST/$binary.worker.js" 2>/dev/null; then
    echo "  - $binary.worker.js"
  else
    echo "  - no $binary.worker.js emitted (fine on newer Emscripten)"
  fi

  docker rm -f "$CONTAINER" >/dev/null

  # Record which optional bridges this build actually carries.
  #
  # The page reads features.json before assembling argv, because QEMU exits on
  # an unknown -chardev backend: guessing wrong would stop an older emulator
  # booting at all rather than merely lose a feature. Detected from the emitted
  # glue rather than hardcoded, so the file can never claim more than is there.
  write_features "$DEST" "$binary"
}

# Probe the Emscripten glue for the exports each optional bridge is known by.
write_features() {
  local dest="$1" binary="$2"
  local -a feats=()

  if grep -q "qemu_browser_monitor_feed" "$dest/$binary.js" 2>/dev/null; then
    feats+=("\"monitor\"")
  fi
  if grep -q "qemu_browser_gdb_feed" "$dest/$binary.js" 2>/dev/null; then
    feats+=("\"gdb\"")
  fi
  if grep -q "qemu_browser_hci_feed" "$dest/$binary.js" 2>/dev/null; then
    feats+=("\"hci\"")
  fi

  local joined
  joined=$(IFS=,; echo "${feats[*]}")
  printf '{\n  "features": [%s]\n}\n' "$joined" > "$dest/features.json"
  echo "  - features.json: [$joined]"
}

# ---------------------------------------------------------------------------

case "$AARCH64_ACCEL" in
  jit|tci) ;;
  *) echo "QEMU_AARCH64_ACCEL must be 'jit' or 'tci' (got '$AARCH64_ACCEL')." >&2; exit 1 ;;
esac

build_dep_image

build_target() {
  local target="$1" src repo_url ref patches accel

  if [ "$target" = "aarch64-softmmu" ] && [ "$AARCH64_ACCEL" = "jit" ]; then
    src="$JIT_SRC"
    repo_url="$JIT_REPO_URL"
    ref="$JIT_REF"
    patches="$ROOT/tools/qemu-jit-patches"
    accel=jit
  elif [ "$target" = "riscv32-softmmu" ]; then
    # Dedicated series: ARM Stellaris / arm-virt patches must not land here.
    src="$TCI_SRC"
    repo_url="$REPO_URL"
    ref="$REF"
    patches="$ROOT/tools/qemu-riscv-patches"
    accel=tci
  else
    src="$TCI_SRC"
    repo_url="$REPO_URL"
    ref="$REF"
    patches="$ROOT/tools/qemu-patches"
    accel=tci
  fi

  fetch_source "$src" "$repo_url" "$ref"
  fetch_subprojects "$src"
  apply_local_patches "$src" "$patches" "$ref"
  build_qemu "$target" "$src" "$accel"
}

if [ "$TARGET_ARG" = "all" ]; then
  build_target arm-softmmu
  build_target aarch64-softmmu
else
  build_target "$TARGET_ARG"
fi

log "Done"
ls -la "$DEST"
cat <<EOF

Next:
  1. Build a guest image:  tools/build-zephyr-image.sh
  2. Restart the dev server — public/qemu/ is only scanned at startup.
EOF
