#!/usr/bin/env bash
# Build the macOS base package on the Mac mini that hosts Ollama.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS build must run on macOS." >&2
  exit 1
fi
npm install
npx electron-packager . ZHIRAI-Base --platform=darwin --arch=arm64 --out=dist --overwrite --asar --prune=true
echo "Built: dist/ZHIRAI-Base-darwin-arm64/"
