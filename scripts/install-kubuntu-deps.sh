#!/usr/bin/env bash
set -euo pipefail

sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

echo
echo "System packages installed."
echo "Next install Rust with rustup, then run:"
echo "  cargo install tauri-cli --version '^2' --locked"
