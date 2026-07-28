#!/usr/bin/env bash
# Build google/libsbc → SINGLE_FILE Emscripten module for the page.
# Requires emsdk on PATH (emcc). Output: public/vendor/libsbc/sbc.umd.cjs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/tools/libsbc-wasm"
OUT="$ROOT/public/vendor/libsbc"
mkdir -p "$OUT"

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not found — install/activate emsdk, then re-run." >&2
  exit 1
fi

emcc \
  "$SRC/upstream/src/sbc.c" \
  "$SRC/upstream/src/bits.c" \
  "$SRC/sbc_wasm.c" \
  -I"$SRC/upstream/include" \
  -I"$SRC/upstream/src" \
  -O2 -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME=createSbcModule \
  -s SINGLE_FILE=1 \
  -s EXPORTED_FUNCTIONS='["_sbc_wasm_reset","_sbc_wasm_probe","_sbc_wasm_decode_frame","_sbc_wasm_max_pcm_samples","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["cwrap","ccall","HEAPU8","HEAP16","getValue","setValue"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web,webview,node \
  -o "$OUT/sbc.umd.cjs"

echo "wrote $OUT/sbc.umd.cjs ($(wc -c < "$OUT/sbc.umd.cjs") bytes)"
