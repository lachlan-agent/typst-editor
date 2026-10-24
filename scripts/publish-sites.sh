#!/usr/bin/env bash
# Builds this app and vendors the bundle into a checkout of the `sites` repo,
# which only publishes it (GitHub Pages). This repo stays the source of truth.
#
#   scripts/publish-sites.sh ../mono    # then review, commit and push in sites
set -euo pipefail

sites=${1:?usage: publish-sites.sh <path-to-sites-checkout>}
sites=$(cd "$sites" && pwd)
dest="$sites/typst-editor"
root=$(cd "$(dirname "$0")/.." && pwd)

cd "$root/web"
if command -v wasm-pack >/dev/null; then
  npm run build:wasm
elif [ -f src/wasm/typst_wasm_bg.wasm ]; then
  echo "wasm-pack not found; reusing the existing src/wasm build" >&2
else
  echo "error: wasm-pack is needed for the first build (cargo install wasm-pack)" >&2
  exit 1
fi
npm run build
rm -rf "$dest"
mkdir -p "$dest"
(cd dist && find . -type f ! -name '*.map' -exec cp --parents {} "$dest" \;)
echo "typst-editor @ $(git -C "$root" rev-parse --short HEAD) -> $dest"
