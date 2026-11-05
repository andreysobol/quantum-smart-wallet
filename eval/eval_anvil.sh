#!/usr/bin/env bash
# Evaluation: keys generated and messages signed by the Rust `rslh` CLI,
# signatures verified ON-CHAIN by the Solidity verifier (slhsol) deployed to a
# local Ethereum node (anvil).
#
# Usage: eval/eval_anvil.sh [-n COUNT] [-k KEY_EVERY] [-m MAX_MSG] [-p PORT] [-x] [-q] [-h]
#
#   -n COUNT      number of signatures to verify, then stop everything and print
#                 the summary (default 0 = unlimited, Ctrl-C stops)
#   -k KEY_EVERY  generate a fresh key pair every KEY_EVERY signatures (default 1)
#   -m MAX_MSG    maximum random message length in bytes (default 1024)
#   -p PORT       anvil RPC port (default 8545)
#   -x            stop at the first failure
#   -q            quiet: print a progress line every 10 signatures instead of each
#
# Steps:
#   1. build rslh and slhsol, start anvil, deploy SlhDsaVerifier
#   2. per signature (random message 0..MAX_MSG bytes, random context 0..64 bytes):
#      - rslh signs, alternating hedged / deterministic
#      - the contract (eth_call) must return true; its gas is estimated
#      - the contract must return false for a modified message, a flipped
#        signature bit and a wrong context
#   3. stop anvil and print the summary
#
# Failing cases are kept under eval/eval_failures/ for reproduction.
# Exit status: 0 = all checks passed, 1 = some check failed, 2 = setup error.
set -uo pipefail

COUNT=0; KEY_EVERY=1; MAX_MSG=1024; PORT=8545; STOP_ON_FAIL=0; QUIET=0
usage() { awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; }
while getopts "n:k:m:p:xqh" opt; do
  case $opt in
    n) COUNT=$OPTARG ;;
    k) KEY_EVERY=$OPTARG ;;
    m) MAX_MSG=$OPTARG ;;
    p) PORT=$OPTARG ;;
    x) STOP_ON_FAIL=1 ;;
    q) QUIET=1 ;;
    h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
shift $((OPTIND-1))
[ $# -eq 0 ] || { echo "unexpected argument: $1" >&2; usage >&2; exit 2; }
is_uint() { [[ $1 =~ ^[0-9]+$ ]]; }
is_uint "$COUNT"     || { echo "-n must be a non-negative integer" >&2; exit 2; }
is_uint "$KEY_EVERY" && [ "$KEY_EVERY" -ge 1 ] || { echo "-k must be >= 1" >&2; exit 2; }
is_uint "$MAX_MSG"   || { echo "-m must be a non-negative integer" >&2; exit 2; }
is_uint "$PORT"      || { echo "-p must be a port number" >&2; exit 2; }

HERE=$(cd "$(dirname "$0")" && pwd)
RSLH="$HERE/../rslh"
SOL="$HERE/../slhsol"
BIN="$RSLH/target/release/rslh"
FAILDIR="$HERE/eval_failures"
RPC="http://127.0.0.1:$PORT"
# anvil's well-known default account #0 (local test chain only)
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
SIG_FN="verify(bytes,bytes,bytes,bytes)(bool)"

PATH="$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
for t in cargo forge cast anvil; do
  command -v "$t" >/dev/null || { echo "$t not found (install Rust / Foundry)" >&2; exit 2; }
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/slh-anvil.XXXXXX")
ANVIL_PID=""
cleanup() {
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null; wait "$ANVIL_PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
stop=0; trap 'stop=1' INT TERM

# ---- 1. build, start node, deploy -------------------------------------------
echo "building rslh and slhsol..."
(cd "$RSLH" && cargo build --release --quiet --bin rslh) || { echo "rslh build failed" >&2; exit 2; }
(cd "$SOL" && forge build --quiet) || { echo "slhsol build failed" >&2; exit 2; }

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "something is already listening on port $PORT; use -p PORT" >&2; exit 2
fi
anvil --port "$PORT" --silent --gas-limit 100000000 > "$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil did not start" >&2; cat "$WORK/anvil.log" >&2; exit 2; }

DEPLOY_OUT=$(cd "$SOL" && forge create src/SlhDsaSha2_128s.sol:SlhDsaVerifier \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast 2>&1) \
  || { echo "deploy failed:" >&2; echo "$DEPLOY_OUT" >&2; exit 2; }
ADDR=$(awk '/Deployed to:/ {print $3}' <<<"$DEPLOY_OUT")
TXH=$(awk '/Transaction hash:/ {print $3}' <<<"$DEPLOY_OUT")
[ -n "$ADDR" ] && [ "$(cast code "$ADDR" --rpc-url "$RPC")" != "0x" ] \
  || { echo "no contract code at '$ADDR'" >&2; echo "$DEPLOY_OUT" >&2; exit 2; }
DEPLOY_GAS=$(cast receipt "$TXH" gasUsed --rpc-url "$RPC" 2>/dev/null || echo "?")

echo "anvil:      $RPC (chain id $(cast chain-id --rpc-url "$RPC"), pid $ANVIL_PID)"
echo "contract:   SlhDsaVerifier at $ADDR (deploy gas $DEPLOY_GAS)"
echo "rslh:       $BIN"
echo "signatures: $([ "$COUNT" -eq 0 ] && echo "unlimited (Ctrl-C to stop)" || echo "$COUNT")"
echo "new key:    every $KEY_EVERY signature(s); messages 0..$MAX_MSG bytes, context 0..64 bytes"
echo

# ---- helpers ------------------------------------------------------------------
hexf() { printf '0x'; od -An -v -tx1 "$1" | tr -d ' \n'; }
rand_u16() { od -An -N2 -tu2 /dev/urandom | tr -d ' '; }
onchain() { cast call "$ADDR" "$SIG_FN" "$1" "$2" "$3" "$4" --rpc-url "$RPC" 2>&1; }
ok()     { local r; r=$(onchain "$2" "$3" "$4" "$5"); [ "$r" = "true" ]  || { it_fail=$((it_fail+1)); it_msgs+=("FAIL: $1 (got: $r)"); }; }
reject() { local r; r=$(onchain "$2" "$3" "$4" "$5"); [ "$r" = "false" ] || { it_fail=$((it_fail+1)); it_msgs+=("FAIL: accepted $1 (got: $r)"); }; }
flip_byte() {  # flip_byte HEX POS -> HEX with byte POS xor 0x01 (HEX has 0x prefix)
  local h=$1 p=$(( 2 + 2*$2 )) b
  b=$(printf '%02x' $(( 0x${h:$p:2} ^ 1 )))
  printf '%s' "${h:0:$p}$b${h:$((p+2))}"
}

KEYDIR="$WORK/key"
new_key() {
  rm -rf "$KEYDIR"; mkdir -p "$KEYDIR"
  "$BIN" keygen --sk "$KEYDIR/sk.key" --pk "$KEYDIR/pk.pub" >/dev/null 2>&1 \
    && "$BIN" export --key "$KEYDIR/pk.pub" --out "$KEYDIR/pk.raw" >/dev/null 2>&1 \
    || { echo "rslh keygen failed" >&2; exit 2; }
  PKHEX=$(hexf "$KEYDIR/pk.raw")
}

# ---- 2. sign with rslh, verify on chain ---------------------------------------
sigs=0; keys=0; passed=0; failed=0; failed_sigs=0; gas_sum=0; gas_min=0; gas_max=0
start=$(date +%s)

while [ "$stop" -eq 0 ] && { [ "$COUNT" -eq 0 ] || [ "$sigs" -lt "$COUNT" ]; }; do
  it_fail=0; it_msgs=(); n=$((sigs+1)); newkey=0
  if [ $((sigs % KEY_EVERY)) -eq 0 ]; then new_key; newkey=1; fi
  d="$WORK/sig"; rm -rf "$d"; mkdir -p "$d"
  mlen=$(( $(rand_u16) % (MAX_MSG+1) ))
  clen=$(( $(rand_u16) % 65 ))
  head -c "$mlen" /dev/urandom > "$d/msg"
  head -c "$clen" /dev/urandom > "$d/ctx"
  cargs=(); [ "$clen" -gt 0 ] && cargs=(--context-hex "$(od -An -v -tx1 "$d/ctx" | tr -d ' \n')")
  if [ $((n % 2)) -eq 0 ]; then mode=deterministic; margs=(--deterministic); else mode=hedged; margs=(); fi
  gas="-"

  if "$BIN" sign --sk "$KEYDIR/sk.key" --in "$d/msg" --sig "$d/sig" "${cargs[@]}" "${margs[@]}" >/dev/null 2>&1; then
    M=$(hexf "$d/msg"); C=$(hexf "$d/ctx"); S=$(hexf "$d/sig")
    ok     "contract verifies $mode signature" "$PKHEX" "$M" "$C" "$S"
    reject "modified message"                   "$PKHEX" "${M}58" "$C" "$S"
    pos=$(( $(rand_u16) % 7856 ))
    reject "signature bit flip at byte $pos"    "$PKHEX" "$M" "$C" "$(flip_byte "$S" "$pos")"
    reject "wrong context"                      "$PKHEX" "$M" "${C}00" "$S"
    checks=4
    gas=$(cast estimate "$ADDR" "verify(bytes,bytes,bytes,bytes)" "$PKHEX" "$M" "$C" "$S" --rpc-url "$RPC" 2>/dev/null || echo "-")
  else
    it_fail=$((it_fail+1)); it_msgs+=("FAIL: rslh sign"); checks=1
  fi

  # Ctrl-C during this iteration kills child processes; discard its partial results.
  [ "$stop" -eq 1 ] && break

  sigs=$n; keys=$((keys + newkey))
  failed=$((failed + it_fail)); passed=$((passed + checks - it_fail))
  if is_uint "$gas"; then
    gas_sum=$((gas_sum + gas))
    { [ "$gas_min" -eq 0 ] || [ "$gas" -lt "$gas_min" ]; } && gas_min=$gas
    [ "$gas" -gt "$gas_max" ] && gas_max=$gas
  fi
  if [ "$it_fail" -gt 0 ]; then
    failed_sigs=$((failed_sigs+1))
    keep="$FAILDIR/$(date +%Y%m%d-%H%M%S)-anvil-sig$n"; mkdir -p "$keep"
    cp -r "$KEYDIR" "$keep/key"; cp -r "$d"/. "$keep/"
    printf '%s\n' "${it_msgs[@]}" > "$keep/failures.txt"
    printf "  #%-6d %-13s FAILED: %s (kept in %s)\n" "$n" "$mode" "$(IFS=';'; echo "${it_msgs[*]}")" "$keep"
    [ "$STOP_ON_FAIL" -eq 1 ] && break
  elif [ "$QUIET" -eq 0 ] || [ $((n % 10)) -eq 0 ]; then
    printf "  #%-6d %-13s msg %4d B  ctx %2d B  gas %-8s ok   [%d checks, %d failed, %ds]\n" \
      "$n" "$mode" "$mlen" "$clen" "$gas" "$passed" "$failed" "$(( $(date +%s) - start ))"
  fi
done

# ---- 3. stop everything, summary ---------------------------------------------
kill "$ANVIL_PID" 2>/dev/null; wait "$ANVIL_PID" 2>/dev/null; ANVIL_PID=""
el=$(( $(date +%s) - start ))
echo
[ "$stop" -eq 1 ] && echo "interrupted."
echo "anvil:              stopped"
echo "signatures checked: $sigs (SLH-DSA-SHA2-128s, verified on chain)"
echo "key pairs:          $keys"
echo "checks:             $passed passed, $failed failed  (failing signatures: $failed_sigs)"
[ "$gas_max" -gt 0 ] && echo "verify gas:         min $gas_min  avg $((gas_sum / sigs))  max $gas_max  (eth_estimateGas)"
echo "time:               ${el}s$( [ "$sigs" -gt 0 ] && awk "BEGIN{printf \"  (%.2f s/signature)\", $el/$sigs}")"
if [ "$failed" -eq 0 ] && [ "$sigs" -gt 0 ]; then
  echo
  echo "SUCCESS: all $sigs rslh signatures verified on chain by $ADDR, all tampered inputs rejected."
  exit 0
elif [ "$sigs" -eq 0 ]; then echo "RESULT: nothing checked"; exit 2
else echo "RESULT: FAIL"; exit 1; fi
