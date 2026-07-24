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

## tools/release.sh does the whole thing

One command builds, packages, releases, and repoints the deploy:

```console
tools/release.sh images      # rebuild the guests, release, move IMAGES_RELEASE
tools/release.sh emulator    # rebuild QEMU, release, move EMULATOR_RELEASE
tools/release.sh all         # both, as one release
```

It picks the tag itself — the highest existing `vN`, plus one — prints the full
plan, and waits for confirmation before anything reaches GitHub. Add `--deploy`
to dispatch the Pages workflow immediately instead of waiting for the next push
to `main`, and `--dry-run` to see the plan and stop.

The flags worth knowing:

| Flag | Effect |
| --- | --- |
| `--deploy` | Dispatch `pages.yml` now, rather than waiting for a push to `main` |
| `--dry-run` | Print the plan and change nothing |
| `--tag <tag>` | Use this tag instead of the next free `vN` |
| `--app <a>` / `--board <b>` | Rebuild one guest rather than all of them; the release still carries the full set |
| `--jobs <n>` | Build `n` guest images concurrently (default 4) |
| `--target <t>` | Build one QEMU target (`arm-softmmu`, `aarch64-softmmu`) |
| `--no-build` | Package and release whatever is already in `public/qemu/` |
| `--no-publish` | Build and package locally, never touch GitHub |
| `--reuse` | Build QEMU from the cached checkout instead of a throwaway one |
| `-y`, `--yes` | Skip the confirmation prompt |

A published emulator build defaults to a **fresh checkout**, because the cached
one keeps whatever patches were applied to it last time — a patch deleted from
the repo would otherwise survive into a release. Local builds (`--no-publish`)
default to the cache, where that is the whole point. `--fresh` and `--reuse`
override either way.

So the three cases are:

- **A page-only change** — push to `main`. Nothing to rebuild or release; the
  deploy reuses whatever the two variables already point at.
- **A guest-only change** (a new sample, a shield or driver edit) —
  `tools/release.sh images --deploy`. No QEMU build, and the emulator binary is
  neither rebuilt nor re-uploaded.
- **An emulator change** (QEMU patches, a browser bridge) —
  `tools/release.sh all --deploy`. The slow path, and the only one that needs it.

## Doing it by hand

`release.sh` is a wrapper; the underlying steps still work on their own, which is
what to fall back to when something goes wrong mid-release:

```console
git switch main
git pull --ff-only origin main

TAG=v22

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

Replace `v22` with the next release tag. The QEMU build is the slow part;
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
