#!/usr/bin/env bash
# Build the web wallet from a clean checkout, on Vercel or locally:
#   1. Rust with the wasm32-unknown-unknown target (rustup, minimal profile), only if missing
#   2. wasm-bindgen CLI at the version in rslh/Cargo.lock: a pinned, sha256-verified
#      prebuilt binary kept in node_modules/.cache/qsw-tools, only if missing
#   3. slhts: npm ci + npm run build (rslh -> WebAssembly -> TypeScript)
#   4. this app: npm run build (typecheck + vite build -> dist/)
#
# Vercel runs it from apps/web (Root Directory) after the install step; the project must
# include files outside the Root Directory so ../../slhts and ../../rslh exist (README.md).
set -euo pipefail

usage() {
  cat <<'EOF'
usage: bash scripts/vercel-build.sh [--check | --tools-only]
  (none)        install missing tools, build slhts, build the app
  --check       report the toolchain and what would be installed; changes nothing
  --tools-only  install missing tools, skip the builds
env: QSW_TOOLS_DIR overrides the wasm-bindgen cache (default node_modules/.cache/qsw-tools)
EOF
}

MODE=build
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  --tools-only) MODE=tools ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[ $# -le 1 ] || { usage >&2; exit 2; }

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_DIR=$(cd "$APP_DIR/../.." && pwd)
SLHTS_DIR=$REPO_DIR/slhts
RSLH_DIR=$REPO_DIR/rslh
TOOLS_DIR=${QSW_TOOLS_DIR:-$APP_DIR/node_modules/.cache/qsw-tools}
CARGO_BIN=${CARGO_HOME:-$HOME/.cargo}/bin
WASM_TARGET=wasm32-unknown-unknown

# Prebuilt wasm-bindgen CLI from https://github.com/wasm-bindgen/wasm-bindgen/releases/tag/0.2.130
# Linux x86_64 (Vercel): .../releases/download/0.2.130/wasm-bindgen-0.2.130-x86_64-unknown-linux-musl.tar.gz
# The sums match the release's .sha256sum files and GitHub's asset digests. When rslh/Cargo.lock
# moves to another wasm-bindgen version, update WBG_PINNED and every sum below.
WBG_PINNED=0.2.130
WBG_RELEASES=https://github.com/wasm-bindgen/wasm-bindgen/releases/download
wbg_sha256() {
  case "$1" in
    x86_64-unknown-linux-musl) echo 9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f ;;
    aarch64-apple-darwin) echo b90ddb9357f584b1af897d58ad77e4cce2b48fc17e2a967bc249a87f72809444 ;;
    x86_64-apple-darwin) echo eb209c115b7cb95832423c1aa3f4d06d6c53f63ef74fc4b6fb79ef0b2eea5f10 ;;
    *) return 1 ;;
  esac
}

log() { printf '[vercel-build] %s\n' "$*"; }
die() { printf '[vercel-build] error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --check collects every problem; the other modes stop at the first one.
PROBLEMS=0
fail() {
  if [ "$MODE" = check ]; then
    printf '[vercel-build] problem: %s\n' "$*" >&2
    PROBLEMS=$((PROBLEMS + 1))
  else
    die "$*"
  fi
}

TMP_DIR=""
cleanup() { if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi; }
trap cleanup EXIT

sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

preflight() {
  if [ ! -f "$SLHTS_DIR/package.json" ] || [ ! -f "$RSLH_DIR/Cargo.lock" ]; then
    die "slhts/ and rslh/ are missing next to apps/. On Vercel, keep Root Directory apps/web and enable \"Include files outside the root directory in the Build Step\"."
  fi
  have node && have npm || die "Node.js and npm are required"
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "Node.js 22 or newer is required (found $(node --version))"
  log "node $(node --version), npm $(npm --version), $(uname -s) $(uname -m)"

  have tar || fail "tar is required"
  have sha256sum || have shasum || fail "sha256sum or shasum is required to verify downloads"
  have cc || have gcc || have clang || fail "a C toolchain (cc) is required: cargo links build scripts with it"
  if [ "$MODE" != tools ] && [ ! -e "$APP_DIR/node_modules/slhts" ]; then
    fail "node_modules/slhts is missing: run npm install in apps/web first (Vercel's install step does this)"
  fi

  WBG_VERSION=$(awk '/^name = "wasm-bindgen"$/ {getline; gsub(/version = |"/, ""); print; exit}' "$RSLH_DIR/Cargo.lock")
  [ -n "$WBG_VERSION" ] || die "wasm-bindgen not found in rslh/Cargo.lock"
}

# Probe from rslh/ so rustup resolves the toolchain the build will use; never auto-install one.
in_rslh() { (cd "$RSLH_DIR" && RUSTUP_AUTO_INSTALL=0 "$@"); }
rust_ok() { in_rslh cargo --version >/dev/null 2>&1 && in_rslh rustc --version >/dev/null 2>&1; }
wasm_target_ok() {
  local sysroot
  sysroot=$(in_rslh rustc --print sysroot 2>/dev/null) && [ -d "$sysroot/lib/rustlib/$WASM_TARGET/lib" ]
}

ensure_rust() {
  # rustup's default location also counts when it is not on PATH (non-login shells, Vercel).
  if [ -d "$CARGO_BIN" ]; then PATH="$CARGO_BIN:$PATH"; fi
  if rust_ok && wasm_target_ok; then
    log "rust: $(in_rslh rustc --version) with $WASM_TARGET"
    return
  fi
  if [ "$MODE" = check ]; then
    if have rustup; then
      log "rust: would use rustup to add a minimal stable toolchain and/or $WASM_TARGET"
    elif rust_ok; then
      fail "rustc lacks $WASM_TARGET and rustup is not installed; add the target to your toolchain or install rustup"
    else
      have curl || fail "curl is required to install Rust"
      log "rust: not found; would install rustup (minimal stable + $WASM_TARGET) into ${CARGO_HOME:-$HOME/.cargo}"
    fi
    return
  fi
  if ! have rustup; then
    if rust_ok; then
      die "rustc lacks the $WASM_TARGET target and rustup is not installed; add the target to your toolchain or install rustup (https://rustup.rs)"
    fi
    have curl || die "curl is required to install Rust"
    log "rust: installing rustup (minimal stable + $WASM_TARGET, PATH files untouched)"
    curl --proto '=https' --tlsv1.2 -sSf --retry 3 https://sh.rustup.rs |
      sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable --target "$WASM_TARGET"
    PATH="$CARGO_BIN:$PATH"
  fi
  if ! rust_ok; then
    log "rust: installing a minimal stable toolchain"
    rustup toolchain install stable --profile minimal --target "$WASM_TARGET"
    rustup default stable
  fi
  if ! wasm_target_ok; then
    log "rust: adding $WASM_TARGET"
    in_rslh rustup target add "$WASM_TARGET"
  fi
  rust_ok && wasm_target_ok || die "Rust with $WASM_TARGET is still unavailable after installation"
  log "rust: $(in_rslh rustc --version) with $WASM_TARGET"
}

host_triple() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo x86_64-unknown-linux-musl ;;
    Darwin-arm64 | Darwin-aarch64) echo aarch64-apple-darwin ;;
    Darwin-x86_64) echo x86_64-apple-darwin ;;
    *) return 1 ;;
  esac
}

# Prints the version, or nothing for a broken binary (must not trip set -e/pipefail).
wbg_version() { { wasm-bindgen --version 2>/dev/null || true; } | awk '{print $2}'; }

ensure_wasm_bindgen() {
  local triple sha url dir found
  triple=$(host_triple) || triple=""
  dir=$TOOLS_DIR/wasm-bindgen-$WBG_VERSION-${triple:-unknown}
  if [ -x "$dir/wasm-bindgen" ]; then PATH="$dir:$PATH"; fi
  if have wasm-bindgen; then
    found=$(wbg_version)
    if [ "$found" = "$WBG_VERSION" ]; then
      log "wasm-bindgen: $found ($(command -v wasm-bindgen))"
      return
    fi
    log "wasm-bindgen: $(command -v wasm-bindgen) is ${found:-an unknown version}; rslh/Cargo.lock needs $WBG_VERSION"
  fi
  local manual="or install it yourself: cargo install wasm-bindgen-cli --version $WBG_VERSION --locked"
  if [ "$WBG_VERSION" != "$WBG_PINNED" ]; then
    fail "rslh/Cargo.lock needs wasm-bindgen $WBG_VERSION but this script pins $WBG_PINNED; update WBG_PINNED and the sha256 sums, $manual"
    return
  fi
  if [ -z "$triple" ] || ! sha=$(wbg_sha256 "$triple"); then
    fail "no pinned wasm-bindgen binary for $(uname -s) $(uname -m); $manual"
    return
  fi
  url=$WBG_RELEASES/$WBG_VERSION/wasm-bindgen-$WBG_VERSION-$triple.tar.gz
  if [ "$MODE" = check ]; then
    have curl || fail "curl is required to download wasm-bindgen"
    log "wasm-bindgen: would download $url (sha256 $sha) into $dir"
    return
  fi
  have curl || die "curl is required to download wasm-bindgen"
  mkdir -p "$TOOLS_DIR"
  TMP_DIR=$(mktemp -d "$TOOLS_DIR/.download.XXXXXX")
  log "wasm-bindgen: downloading $url"
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$TMP_DIR/wbg.tar.gz" "$url"
  found=$(sha256_of "$TMP_DIR/wbg.tar.gz")
  [ "$found" = "$sha" ] || die "wasm-bindgen checksum mismatch for $url: expected $sha, got $found"
  tar -xzf "$TMP_DIR/wbg.tar.gz" -C "$TMP_DIR"
  [ -x "$TMP_DIR/wasm-bindgen-$WBG_VERSION-$triple/wasm-bindgen" ] || die "unexpected wasm-bindgen archive layout"
  rm -rf "$dir"
  mv "$TMP_DIR/wasm-bindgen-$WBG_VERSION-$triple" "$dir"
  PATH="$dir:$PATH"
  found=$(wbg_version)
  [ "$found" = "$WBG_VERSION" ] || die "downloaded wasm-bindgen reports '${found:-nothing}', expected $WBG_VERSION"
  log "wasm-bindgen: $found (sha256 verified, $dir)"
}

build() {
  log "slhts: npm ci && npm run build (rslh -> WebAssembly -> TypeScript)"
  (cd "$SLHTS_DIR" && npm ci --include=dev --no-audit --no-fund && npm run build)
  if [ ! -s "$SLHTS_DIR/pkg/rslh_bg.wasm" ] || [ ! -f "$SLHTS_DIR/dist/index.js" ]; then
    die "the slhts build did not produce pkg/rslh_bg.wasm and dist/index.js"
  fi
  log "web: npm run build (typecheck + vite build)"
  (cd "$APP_DIR" && npm run build)
  log "done: $APP_DIR/dist"
}

preflight
ensure_rust
ensure_wasm_bindgen
case "$MODE" in
  check)
    [ "$PROBLEMS" -eq 0 ] || die "$PROBLEMS problem(s) found"
    log "check passed; run without --check to install what is missing and build"
    ;;
  tools) log "tools ready" ;;
  build) build ;;
esac
