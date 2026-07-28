# Vendored Bumble (Bluetooth stack for the in-page controller)

The page runs a [Bumble](https://github.com/google/bumble) **virtual
controller** under [Pyodide](https://pyodide.org/), speaking HCI H:4 to the
Zephyr guest over the `hci0` browser chardev. Hive apps are optional peers on
the same LocalLink — see
[`docs/bluetooth-bumble-feasibility.md`](../../../docs/bluetooth-bumble-feasibility.md).

## Layout

```
public/vendor/bumble/
  README.md                 # this file (tracked)
  manifest.json             # pin + provenance (tracked)
  bumble-<ver>-py3-none-any.whl   # fetched, gitignored
```

Pyodide itself is **not** mirrored here by default: the runtime loads a pinned
CDN build (`src/bt/bumbleController.ts` → `PYODIDE_INDEX_URL`). To air-gap or
pin offline, set `VITE_PYODIDE_INDEX_URL` to a local mirror under
`public/vendor/pyodide/` and document the mirror steps next to that tree.

## Fetch / refresh

```console
$ tools/vendor-bumble.sh              # downloads the pinned wheel
$ tools/vendor-bumble.sh 0.0.233      # same, explicit version
```

The script writes `manifest.json` and the `.whl` next to this README. The wheel
is gitignored (`public/vendor/bumble/*.whl`); CI and local demos run the script
before `npm run build` / pages deploy when Bluetooth samples are enabled.

## Why not npm / zephyr-module vendor?

| Tree | For |
| --- | --- |
| `zephyr-module/drivers/vendor/` | Pristine **Zephyr C** drivers (see its `VENDOR.md`) |
| `src/vendor/littlefs-js/` | Small **JS/Wasm** helpers imported by Vite |
| `public/vendor/bumble/` | Large **Python wheel** lazy-fetched by Pyodide at runtime |

Bumble is Apache-2.0. On Emscripten it only needs `pyee` + `cryptography`
(other deps are gated `platform_system != "Emscripten"`).
