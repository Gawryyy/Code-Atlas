#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p src/assets/logo
if [[ -f assets/logo/logo.png ]]; then
  cp assets/logo/logo.png src/assets/logo/logo.png
else
  echo "CodeAtlas: assets/logo/logo.png is missing." >&2
  exit 1
fi

cargo tauri dev

