#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_OUT="$ROOT_DIR/target/wasm32-unknown-unknown/release/starforge_hyperdrive.wasm"
PUBLIC_OUT="$ROOT_DIR/web/public/starforge_hyperdrive.wasm"

cargo build \
  --manifest-path "$ROOT_DIR/Cargo.toml" \
  --release \
  --target wasm32-unknown-unknown

cp "$WASM_OUT" "$PUBLIC_OUT"
printf 'Built %s\n' "$PUBLIC_OUT"
