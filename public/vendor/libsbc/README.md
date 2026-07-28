# Vendored SBC decoder (google/libsbc → WASM)

Apache-2.0 [google/libsbc](https://github.com/google/libsbc) compiled with
Emscripten for in-page A2DP sink playback. Hive's speaker UI cannot play SBC
via WebCodecs (AAC/Opus only); we decode to PCM here and feed Web Audio.

## Layout

```
public/vendor/libsbc/
  README.md       # this file
  sbc.umd.cjs     # SINGLE_FILE modularize build (wasm inlined)

tools/libsbc-wasm/
  sbc_wasm.c      # thin exports
  upstream/       # pristine libsbc sources + LICENSE
```

## Rebuild

```console
$ source path/to/emsdk_env.sh
$ tools/build-libsbc-wasm.sh
```

The committed `sbc.umd.cjs` is enough for demos; rebuild when bumping libsbc or the
wrapper.
