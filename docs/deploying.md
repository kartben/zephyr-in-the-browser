# Deploying

Pushes to `main` deploy the site to GitHub Pages
([.github/workflows/pages.yml](../.github/workflows/pages.yml)). The emulator
binaries and guest ELFs are not checked into git, so they travel as **two
release assets**, pinned independently:

| Asset | Repository variable | Produced by | Rebuild cost |
| --- | --- | --- | --- |
| `qemu-wasm-emulator.tar.gz` | `EMULATOR_RELEASE` | `tools/build-qemu-wasm.sh` | slow, containerised, ~100 MB |
| `zephyr-images.tar.gz` | `IMAGES_RELEASE` | `tools/build-zephyr-image.sh` | minutes, small |

They are separate so the slow half can stay where it is. `IMAGES_RELEASE` falls
back to `EMULATOR_RELEASE` when unset, and releases cut before the split — which
carry a single `qemu-wasm-artifacts.tar.gz` — still deploy unchanged. Without
either variable, Pages ships the mock backend only.

Prerequisites for anything below are Docker and an authenticated
[GitHub CLI](https://cli.github.com/) (`gh auth login`).

## A page-only change

Push to `main`. Nothing to rebuild, nothing to release — the deploy reuses
whatever the two variables already point at.

## A guest-only change — a new sample, a shield or driver edit

No QEMU build, and the emulator binary is neither rebuilt nor re-uploaded:

```console
TAG=v12

# Rebuild every board/app entry in tools/samples.manifest.
tools/build-zephyr-image.sh

# Package and release just the guest images.
tools/package-emulator.sh "$TAG" --images

# Make future pushes use them, and deploy immediately.
gh variable set IMAGES_RELEASE --body "$TAG"
gh workflow run pages.yml -f images_release="$TAG"
```

## An emulator change — QEMU patches, a browser bridge

This is the slow path, and the only one that needs it:

```console
git switch main
git pull --ff-only origin main

TAG=v12

# Use a fresh source tree so this release cannot reuse an older QEMU checkout.
QEMU_BUILD_DIR="$(mktemp -d)"
QEMU_WORKDIR="$QEMU_BUILD_DIR" tools/build-qemu-wasm.sh

# Rebuild every board/app entry in tools/samples.manifest.
tools/build-zephyr-image.sh

# Install the pinned web dependencies, then type-check and verify the build.
npm ci
npm run build

# Create the release and upload both assets.
tools/package-emulator.sh "$TAG"

# Make future pushes use this release, and deploy it immediately.
gh variable set EMULATOR_RELEASE --body "$TAG"
gh variable set IMAGES_RELEASE --body "$TAG"
gh workflow run pages.yml -f emulator_release="$TAG" -f images_release="$TAG"

# Inspect the release and the latest Pages runs.
gh release view "$TAG"
gh run list --workflow pages.yml --limit 5

rm -rf -- "$QEMU_BUILD_DIR"
```

Replace `v12` with the next release tag. The QEMU build is the slow part;
`tools/build-qemu-wasm.sh` builds Cortex-M with TCI and Cortex-A53 with the
WebAssembly JIT. For faster development rebuilds, omit `QEMU_WORKDIR` to reuse
the cached `.qemu-wasm-build` source and dependency image. You can also rebuild
one emulator target or one guest, for example:

```console
tools/build-qemu-wasm.sh aarch64-softmmu
tools/build-zephyr-image.sh qemu_cortex_a53 display
```

See the usage comments at the top of each script for all accepted options.

`tools/package-emulator.sh` takes `--emulator` or `--images` to package one half
alone; with neither it packages both. Given a tag it creates the GitHub release,
or replaces just those assets if the tag already exists. The explicit workflow
dispatch deploys a new release without requiring another source commit.

A couple of details are handled for you: static hosts can't set the cross-origin
isolation headers QEMU needs, so the deployed build uses
[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) to add them
client-side. And since the emulator is GPLv2-licensed QEMU, this repo being
public — with release notes pointing at the pinned sources — satisfies the
corresponding-source requirement.
