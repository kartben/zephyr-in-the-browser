#!/usr/bin/env bash
#
# Build, package and publish the emulator and/or the Zephyr guest images.
#
#   tools/release.sh images      # rebuild guests, release, point IMAGES_RELEASE at it
#   tools/release.sh emulator    # rebuild QEMU, release, point EMULATOR_RELEASE at it
#   tools/release.sh all         # both, as one release
#
# The tag is picked for you: the highest existing vN release, plus one. Nothing
# is published until you confirm, and --dry-run shows the whole plan without
# touching anything.
#
# Common variations:
#   tools/release.sh images --deploy          # ...and make it live right now
#   tools/release.sh images --app blinky      # rebuild one guest, ship the set
#   tools/release.sh emulator --no-publish    # build and package, stop there
#   tools/release.sh images --no-build        # ship what is already built
#
# Options:
#   --tag <tag>     use this tag instead of the next free vN
#   --board <b>     build only this board's images     (images/all)
#   --app <a>       build only this app's image        (images/all)
#   --jobs <n>      build n guest images at a time     (images/all, default 4)
#   --target <t>    build only this QEMU target        (emulator/all)
#   --no-build      package what is already in public/qemu/, build nothing
#   --no-publish    build and package only; never touch GitHub
#   --deploy        dispatch pages.yml so the release goes live immediately
#   --fresh         build QEMU from a throwaway checkout (default when publishing)
#   --reuse         build QEMU from the cached .qemu-wasm-build checkout
#   -y, --yes       do not ask before publishing
#   -n, --dry-run   print the plan and exit
#
# Why --fresh is the default for a published emulator: the cached checkout keeps
# whatever patches were applied to it last time, so a patch deleted from the repo
# would silently survive into a release. Local builds default to --reuse, because
# there the cache is the whole point.

set -euo pipefail

WHAT=""
TAG=""
BOARD=""
APP=""
JOBS=""
TARGET=""
DO_BUILD=1
DO_PUBLISH=1
DO_DEPLOY=0
FRESH=""
ASSUME_YES=0
DRY_RUN=0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Print the header comment block verbatim, so the usage text and the docs at the
# top of this file cannot drift apart.
usage() {
  awk 'NR>2 && /^#/ { sub(/^# ?/, ""); print; next } NR>2 { exit }' "${BASH_SOURCE[0]}"
  exit "${1:-2}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    images|emulator|all)
      [ -z "$WHAT" ] || die "component given twice ('$WHAT' and '$1')"
      WHAT="$1" ;;
    --tag)     TAG="${2:?--tag needs a value}"; shift ;;
    --board)   BOARD="${2:?--board needs a value}"; shift ;;
    --app)     APP="${2:?--app needs a value}"; shift ;;
    --jobs|-j) JOBS="${2:?--jobs needs a value}"; shift ;;
    --target)  TARGET="${2:?--target needs a value}"; shift ;;
    --no-build)   DO_BUILD=0 ;;
    --no-publish) DO_PUBLISH=0 ;;
    --deploy)     DO_DEPLOY=1 ;;
    --fresh)      FRESH=1 ;;
    --reuse)      FRESH=0 ;;
    -y|--yes)     ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help)    usage 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
  shift
done

[ -n "$WHAT" ] || { echo "Which half? images, emulator, or all." >&2; echo >&2; usage; }

want_emulator() { [ "$WHAT" = all ] || [ "$WHAT" = emulator ]; }
want_images()   { [ "$WHAT" = all ] || [ "$WHAT" = images ]; }

if [ -n "$TARGET" ] && ! want_emulator; then die "--target only applies to an emulator build"; fi
if [ -n "$BOARD$APP$JOBS" ] && ! want_images; then die "--board/--app/--jobs only apply to an images build"; fi
if [ "$DO_BUILD" = 0 ] && [ "$DO_PUBLISH" = 0 ]; then die "--no-build with --no-publish leaves nothing to do"; fi
if [ "$DO_DEPLOY" = 1 ] && [ "$DO_PUBLISH" = 0 ]; then die "--deploy needs publishing; drop --no-publish"; fi

# Fresh checkouts protect a *published* emulator from stale patches; locally the
# cache is what makes rebuilds bearable.
if [ -z "$FRESH" ]; then
  if [ "$DO_PUBLISH" = 1 ]; then FRESH=1; else FRESH=0; fi
fi

# --- preflight --------------------------------------------------------------

if [ "$DO_BUILD" = 1 ]; then
  command -v docker >/dev/null 2>&1 \
    || die "docker not found — both build scripts run in containers"
fi

if [ "$DO_PUBLISH" = 1 ]; then
  command -v gh >/dev/null 2>&1 \
    || die "gh not found — install the GitHub CLI, or pass --no-publish"
  gh auth status >/dev/null 2>&1 \
    || die "gh is not authenticated — run 'gh auth login', or pass --no-publish"
fi

# Highest existing vN, plus one. Tags that are not plain vN are ignored rather
# than parsed, so a one-off tag cannot derail the sequence.
next_tag() {
  local listed max=0 n
  listed=$(gh release list --limit 200 --json tagName -q '.[].tagName' 2>/dev/null || true)
  while read -r t; do
    [[ "$t" =~ ^v([0-9]+)$ ]] || continue
    n="${BASH_REMATCH[1]}"
    if [ "$n" -gt "$max" ]; then max="$n"; fi
  done <<<"$listed"
  echo "v$((max + 1))"
}

TAG_IS_NEW=1
if [ "$DO_PUBLISH" = 1 ]; then
  if [ -z "$TAG" ]; then
    TAG="$(next_tag)"
  elif gh release view "$TAG" >/dev/null 2>&1; then
    TAG_IS_NEW=0
  fi
fi

# --- plan -------------------------------------------------------------------

log "Plan"
if [ "$DO_BUILD" = 1 ]; then
  if want_emulator; then
    note "build emulator   tools/build-qemu-wasm.sh ${TARGET:-all}$([ "$FRESH" = 1 ] && echo '  (fresh checkout)' || echo '  (cached checkout)')"
  fi
  if want_images; then
    note "build images     tools/build-zephyr-image.sh ${BOARD:-all} ${APP:-all}  (${JOBS:-4} at a time)"
  fi
else
  note "build            skipped (--no-build), packaging public/qemu/ as-is"
fi

case "$WHAT" in
  emulator) note "package          qemu-wasm-emulator.tar.gz" ;;
  images)   note "package          zephyr-images.tar.gz" ;;
  all)      note "package          qemu-wasm-emulator.tar.gz + zephyr-images.tar.gz" ;;
esac

if [ "$DO_PUBLISH" = 1 ]; then
  note "release          $TAG $([ "$TAG_IS_NEW" = 1 ] && echo '(new)' || echo '(EXISTS — its assets will be replaced)')"
  if want_emulator; then note "variable         EMULATOR_RELEASE = $TAG"; fi
  if want_images;   then note "variable         IMAGES_RELEASE   = $TAG"; fi
  if [ "$DO_DEPLOY" = 1 ]; then
    note "deploy           dispatch pages.yml now"
  else
    note "deploy           on the next push to main"
  fi
else
  note "publish          skipped (--no-publish)"
fi

if [ "$DRY_RUN" = 1 ]; then
  log "Dry run — nothing was changed."
  exit 0
fi

if [ "$DO_PUBLISH" = 1 ] && [ "$ASSUME_YES" = 0 ]; then
  # Publishing moves the live site, so it is opt-in rather than assumed.
  [ -t 0 ] || die "not a terminal and no --yes; refusing to publish unattended"
  printf '\nPublish %s and repoint the deploy? [y/N] ' "$TAG"
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted — nothing was built or published."; exit 1 ;;
  esac
fi

# --- build ------------------------------------------------------------------

if [ "$DO_BUILD" = 1 ] && want_emulator; then
  if [ "$FRESH" = 1 ]; then
    QEMU_BUILD_DIR="$(mktemp -d)"
    trap 'rm -rf -- "${QEMU_BUILD_DIR:-}"' EXIT
    log "Building the emulator in a throwaway checkout"
    QEMU_WORKDIR="$QEMU_BUILD_DIR" "$ROOT/tools/build-qemu-wasm.sh" ${TARGET:+"$TARGET"}
  else
    log "Building the emulator from the cached checkout"
    "$ROOT/tools/build-qemu-wasm.sh" ${TARGET:+"$TARGET"}
  fi
fi

if [ "$DO_BUILD" = 1 ] && want_images; then
  log "Building the guest images"
  "$ROOT/tools/build-zephyr-image.sh" "${BOARD:-all}" "${APP:-all}" ${JOBS:+-j "$JOBS"}
fi

# --- package and publish ----------------------------------------------------

# 'all' passes no selector, which is package-emulator.sh's own default. Expanded
# with the +alternate guard so an empty array is not an unbound variable under
# `set -u` on bash 3.2, which is what macOS still ships.
PKG_ARGS=()
case "$WHAT" in
  emulator) PKG_ARGS+=(--emulator) ;;
  images)   PKG_ARGS+=(--images) ;;
esac

export ZITB_DRIVEN_BY_RELEASE=1

if [ "$DO_PUBLISH" = 1 ]; then
  "$ROOT/tools/package-emulator.sh" "$TAG" ${PKG_ARGS[@]+"${PKG_ARGS[@]}"}

  log "Pointing the deploy at $TAG"
  if want_emulator; then gh variable set EMULATOR_RELEASE --body "$TAG"; note "EMULATOR_RELEASE = $TAG"; fi
  if want_images;   then gh variable set IMAGES_RELEASE   --body "$TAG"; note "IMAGES_RELEASE   = $TAG"; fi

  if [ "$DO_DEPLOY" = 1 ]; then
    DISPATCH=()
    if want_emulator; then DISPATCH+=(-f "emulator_release=$TAG"); fi
    if want_images;   then DISPATCH+=(-f "images_release=$TAG"); fi
    log "Deploying"
    gh workflow run pages.yml "${DISPATCH[@]}"
    note "watch it with: gh run list --workflow pages.yml --limit 5"
  fi

  log "Done — $TAG"
  gh release view "$TAG" --json url -q .url 2>/dev/null || true
  [ "$DO_DEPLOY" = 1 ] || note "It goes live on the next push to main, or re-run with --deploy."
else
  "$ROOT/tools/package-emulator.sh" ${PKG_ARGS[@]+"${PKG_ARGS[@]}"}
  log "Done — packaged, not published."
fi
