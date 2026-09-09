#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_OUT="$ROOT_DIR/target/wasm32-unknown-unknown/release/starforge_hyperdrive.wasm"
PUBLIC_OUT="$ROOT_DIR/web/public/starforge_hyperdrive.wasm"

mkdir -p "$(dirname "$PUBLIC_OUT")"

cargo build \
  --locked \
  --manifest-path "$ROOT_DIR/Cargo.toml" \
  --release \
  --target wasm32-unknown-unknown

mkdir -p "$(dirname "$PUBLIC_OUT")"

if command -v wasm-opt >/dev/null 2>&1; then
  # rustc emits saturating float-to-int, sign extension, and bulk memory.
  # Default wasm-opt validates MVP only, which rejects that module.
  if wasm-opt -Oz \
    --enable-nontrapping-float-to-int \
    --enable-sign-ext \
    --enable-mutable-globals \
    --enable-bulk-memory \
    "$WASM_OUT" \
    -o "$PUBLIC_OUT"; then
    printf 'Built and optimized %s\n' "$PUBLIC_OUT"
  else
    cp "$WASM_OUT" "$PUBLIC_OUT"
    printf 'wasm-opt rejected the module; copied unoptimized %s\n' "$PUBLIC_OUT"
  fi
else
  cp "$WASM_OUT" "$PUBLIC_OUT"
  printf 'Built %s (install binaryen for wasm-opt)\n' "$PUBLIC_OUT"
fi