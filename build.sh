#!/usr/bin/env bash
# Builds Tokenstreak.app and a .dmg for this Mac (unsigned; ad-hoc signed so
# it runs locally). Works with the Xcode Command Line Tools alone.
#
#   ./build.sh           build
#   ./build.sh --clean   remove previous build outputs first
#   ./build.sh --test    run the Rust and TypeScript test suites before building
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
CLEAN=0
TEST=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --test) TEST=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required ($2)" >&2; exit 1; }; }

bold "==> Checking tools"
need node "https://nodejs.org (v20+)"
need pnpm "npm i -g pnpm"
need cargo "https://rustup.rs"
xcode-select -p >/dev/null 2>&1 || { echo "error: install the Command Line Tools: xcode-select --install" >&2; exit 1; }
echo "node $(node -v) · pnpm $(pnpm -v) · $(rustc --version)"

if [[ $CLEAN == 1 ]]; then
  bold "==> Cleaning previous outputs"
  rm -rf dist target/release/bundle
fi

bold "==> Installing JavaScript dependencies"
pnpm install --frozen-lockfile

if [[ $TEST == 1 ]]; then
  bold "==> Running tests"
  cargo test -p tokenstreak-core
  pnpm test
fi

bold "==> Building the app (release)"
pnpm tauri build --bundles app,dmg

BUNDLE="$ROOT/target/release/bundle"
APP="$BUNDLE/macos/Tokenstreak.app"
DMG="$(ls -t "$BUNDLE"/dmg/Tokenstreak_*.dmg 2>/dev/null | head -1 || true)"
[[ -d "$APP" ]] || { echo "error: $APP was not produced" >&2; exit 1; }
[[ -n "$DMG" && -f "$DMG" ]] || { echo "error: no .dmg was produced" >&2; exit 1; }

bold "==> Verifying"
codesign --verify --deep --strict "$APP" && echo "signature: ad-hoc, valid"
hdiutil verify "$DMG" >/dev/null && echo "dmg: checksum valid"

echo
bold "Built:"
printf '  %-5s %s (%s)\n' "app" "$APP" "$(du -sh "$APP" | cut -f1)"
printf '  %-5s %s (%s)\n' "dmg" "$DMG" "$(du -sh "$DMG" | cut -f1)"
echo
echo "Unsigned build: on first launch, right-click the app and choose Open (Gatekeeper)."
