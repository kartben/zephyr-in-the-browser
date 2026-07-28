# libsbc WASM wrapper

Sources under `upstream/` are a snapshot of
[google/libsbc](https://github.com/google/libsbc) (Apache-2.0).
`sbc_wasm.c` exports probe/decode entry points for the page.

```console
$ source path/to/emsdk_env.sh
$ tools/build-libsbc-wasm.sh   # → public/vendor/libsbc/sbc.umd.cjs
```
