#!/usr/bin/env bash
#
# Fetch the pinned Bumble wheel into public/vendor/bumble/.
#
#   tools/vendor-bumble.sh [version]
#
# Default version matches public/vendor/bumble/manifest.json. Re-run after
# bumping the pin; commit the updated manifest + README, not the .whl.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/public/vendor/bumble"
VERSION="${1:-}"
MANIFEST="$DEST/manifest.json"

mkdir -p "$DEST"

if [ -z "$VERSION" ]; then
  if [ -f "$MANIFEST" ]; then
    VERSION=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['version'])")
  else
    VERSION=0.0.233
  fi
fi

echo "Resolving bumble==$VERSION from PyPI…"
meta=$(curl -fsSL "https://pypi.org/pypi/bumble/$VERSION/json")
wheel_url=$(python3 -c "import json,sys; j=json.load(sys.stdin); print(next(u['url'] for u in j['urls'] if u['packagetype']=='bdist_wheel'))" <<<"$meta")
wheel_name=$(basename "$wheel_url")

echo "Downloading $wheel_name"
curl -fsSL -o "$DEST/$wheel_name" "$wheel_url"

python3 - "$DEST" "$VERSION" "$wheel_name" "$wheel_url" <<'PY'
import json, sys
dest, version, wheel_name, wheel_url = sys.argv[1:5]
manifest = {
    "package": "bumble",
    "version": version,
    "wheel": wheel_name,
    "source": f"https://pypi.org/project/bumble/{version}/",
    "wheelUrl": wheel_url,
    "license": "Apache-2.0",
    "pyodide": {
        "version": "0.27.5",
        "indexURL": "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/",
    },
    "notes": "Fetched by tools/vendor-bumble.sh. Wheel is gitignored; this manifest is the pin.",
}
path = f"{dest}/manifest.json"
with open(path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(f"Wrote {path}")
PY

echo "OK: $DEST/$wheel_name"
echo "Remember: *.whl is gitignored; commit manifest.json + README.md only."
