#!/usr/bin/env bash
# Permit2 pins Solidity 0.8.17; the v4 source graph pins 0.8.26.
# Build its unmodified official source in its own compiler project, then let
# DeployDemo read lib/permit2/out/Permit2.sol/Permit2.json with vm.getCode.
set -euo pipefail
PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
forge build --root "$PROJECT_ROOT/lib/permit2" --skip test --skip script
