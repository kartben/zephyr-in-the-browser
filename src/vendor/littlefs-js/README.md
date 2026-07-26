# Vendored littlefs-js (Dreagonmon) — littlefs v2.11 / disk v2.1

Real littlefs (C → Emscripten) for mounting Zephyr-formatted SPI NOR images in
the dock Filesystem dialog.

Built from [Dreagonmon/littlefs-js](https://github.com/Dreagonmon/littlefs-js)
against [littlefs v2.11.0](https://github.com/littlefs-project/littlefs/releases/tag/v2.11.0)
(`LFS_DISK_VERSION` 2.1), matching Zephyr’s current littlefs module. The
upstream release asset is still v2.5.1.0 (disk v2.0), which cannot mount
guest-formatted volumes (`lfs_mount` → `-84` / `LFS_ERR_CORRUPT`).

Rebuild (needs [emsdk](https://emscripten.org/docs/getting_started/downloads.html)):

```bash
git clone https://github.com/Dreagonmon/littlefs-js.git
cd littlefs-js && git submodule update --init
git -C littlefs fetch --tags && git -C littlefs checkout v2.11.0
# export HEAPU8 for the JS BlockDevice bindings:
#   -sEXPORTED_RUNTIME_METHODS="['cwrap','addFunction','HEAPU8']"
make
```

Upstream wrapper license: MIT (see `LICENSE`). littlefs itself is BSD-3-Clause.
