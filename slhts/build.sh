#!/usr/bin/env bash
# Build ../rslh (cargo feature `wasm`, bindings in rslh/src/wasm.rs) as WebAssembly and generate the JavaScript/TypeScript bindings in pkg/.
# Needs: rustup target add wasm32-unknown-unknown
#        cargo install wasm-bindgen-cli --version <same as wasm-bindgen in Cargo.lock>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../rslh"
cargo rustc --lib --release --locked --target wasm32-unknown-unknown --features wasm --crate-type cdylib
wasm-bindgen --target web --out-dir "$HERE/pkg" target/wasm32-unknown-unknown/release/rslh.wasm
echo "wasm bindings -> $HERE/pkg ($(wc -c < "$HERE/pkg/rslh_bg.wasm") bytes)"
