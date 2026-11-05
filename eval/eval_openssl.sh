#!/usr/bin/env bash
# Evaluation: keys generated and messages signed by the Rust `rslh` CLI,
# signatures verified by OpenSSL's independent SLH-DSA implementation (>= 3.5).
#
# Usage: eval/eval_openssl.sh [-n COUNT] [-a sha2|shake|both] [-k KEY_EVERY]
#                                [-m MAX_MSG] [-x] [-q] [-h]
#
#   -n COUNT      number of signatures to check (default: run forever, Ctrl-C
#                 stops and prints the summary)
#   -a ALG        sha2 (default), shake, or both (alternates per key pair)
#   -k KEY_EVERY  generate a fresh key pair every KEY_EVERY signatures (default 1)
#   -m MAX_MSG    maximum random message length in bytes (default 4096)
#   -x            stop at the first failure
#   -q            quiet: print a progress line every 10 signatures instead of each
#
# For every new key pair:
#   - raw key -> SPKI / PKCS#8 PEM; OpenSSL must load it and derive the same public key
# For every signature (random message 0..MAX_MSG bytes, random context 0..64 bytes):
#   - rslh signs, alternating hedged / deterministic (per parameter set)
#   - openssl pkeyutl -verify must ACCEPT it
#   - OpenSSL must REJECT a modified message, a flipped signature bit and a wrong context
#   - deterministic signatures must equal OpenSSL's own deterministic signature
#
# Failing cases are kept under eval/eval_failures/ for reproduction.
# Exit status: 0 = all checks passed, 1 = some check failed, 2 = setup error.
set -uo pipefail

COUNT=0; ALG=sha2; KEY_EVERY=1; MAX_MSG=4096; STOP_ON_FAIL=0; QUIET=0
usage() { awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; }
while getopts "n:a:k:m:xqh" opt; do
  case $opt in
    n) COUNT=$OPTARG ;;
    a) ALG=$OPTARG ;;
    k) KEY_EVERY=$OPTARG ;;
    m) MAX_MSG=$OPTARG ;;
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
case $ALG in sha2) ALGS=(sha2) ;; shake) ALGS=(shake) ;; both) ALGS=(sha2 shake) ;;
  *) echo "-a must be sha2, shake or both" >&2; exit 2 ;; esac

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../rslh" && pwd)
BIN="$ROOT/target/release/rslh"
FAILDIR="$HERE/eval_failures"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/slh-eval.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 2; }
openssl list -signature-algorithms 2>/dev/null | grep -q SLH-DSA-SHA2-128s \
  || { echo "this OpenSSL ($(openssl version)) has no SLH-DSA; need >= 3.5" >&2; exit 2; }
command -v cargo >/dev/null || PATH="$HOME/.cargo/bin:$PATH"
(cd "$ROOT" && cargo build --release --quiet --bin rslh) || { echo "build failed" >&2; exit 2; }

# DER prefixes (RFC 9909): AlgorithmIdentifier OIDs 2.16.840.1.101.3.4.3.{20,26}
oid_hex()  { case $1 in sha2) echo 0609608648016503040314 ;; shake) echo 060960864801650304031a ;; esac; }
alg_name() { case $1 in sha2) echo SLH-DSA-SHA2-128s ;; shake) echo SLH-DSA-SHAKE-128s ;; esac; }
hex2bin()  { local h=$1 out=""; while [ -n "$h" ]; do out+="\\x${h:0:2}"; h=${h:2}; done; printf "$out"; }
bin2hex()  { od -An -v -tx1 "$1" | tr -d ' \n'; }
rand_u16() { od -An -N2 -tu2 /dev/urandom | tr -d ' '; }
to_pem()   { { echo "-----BEGIN $2-----"; hex2bin "$1" | openssl base64; echo "-----END $2-----"; } > "$3"; }

ossl_verify() { # pubpem msg sig ctxhex
  local opts=(); [ -n "$4" ] && opts=(-pkeyopt "hexcontext-string:$4")
  openssl pkeyutl -verify -pubin -inkey "$1" -in "$2" -sigfile "$3" "${opts[@]}" >/dev/null 2>&1; }

# Per-iteration result; committed to the totals only if the iteration was not interrupted.
it_fail=0; it_msgs=()
ok()     { local d=$1; shift; "$@" >/dev/null 2>&1 || { it_fail=$((it_fail+1)); it_msgs+=("FAIL: $d"); }; }
reject() { local d=$1; shift; "$@" >/dev/null 2>&1 && { it_fail=$((it_fail+1)); it_msgs+=("FAIL (accepted): $d"); }; }
checks_per_sig=0

stop=0
trap 'stop=1' INT TERM

new_key() { # $1 = alg; sets KEYDIR, sets it_fail on problems
  KEYDIR="$WORK/key"; rm -rf "$KEYDIR"; mkdir -p "$KEYDIR"
  "$BIN" keygen --alg "$1" --sk "$KEYDIR/sk.key" --pk "$KEYDIR/pk.key" >/dev/null 2>&1 \
    && "$BIN" export --key "$KEYDIR/sk.key" --out "$KEYDIR/sk.raw" >/dev/null 2>&1 \
    && "$BIN" export --key "$KEYDIR/pk.key" --out "$KEYDIR/pk.raw" >/dev/null 2>&1 \
    || { it_fail=$((it_fail+1)); it_msgs+=("FAIL: rslh keygen/export"); return 1; }
  local oid; oid=$(oid_hex "$1")
  to_pem "3030300b${oid}032100$(bin2hex "$KEYDIR/pk.raw")" "PUBLIC KEY" "$KEYDIR/pub.pem"
  to_pem "3052020100300b${oid}0440$(bin2hex "$KEYDIR/sk.raw")" "PRIVATE KEY" "$KEYDIR/priv.pem"
  ok "OpenSSL parses public key" openssl pkey -pubin -in "$KEYDIR/pub.pem" -noout
  openssl pkey -in "$KEYDIR/priv.pem" -pubout -out "$KEYDIR/derived.pem" >/dev/null 2>&1
  ok "OpenSSL derives same public key" cmp -s "$KEYDIR/pub.pem" "$KEYDIR/derived.pem"
}

echo "OpenSSL:    $(openssl version)"
echo "rslh:    $BIN"
echo "algorithm:  $(for a in "${ALGS[@]}"; do printf '%s ' "$(alg_name "$a")"; done)"
echo "signatures: $([ "$COUNT" -eq 0 ] && echo "unlimited (Ctrl-C to stop)" || echo "$COUNT")"
echo "new key:    every $KEY_EVERY signature(s); messages 0..$MAX_MSG bytes"
echo

sigs=0; keys=0; passed=0; failed=0; failed_sigs=0; alg_i=0; cur_alg=""
declare -A per_alg_sigs
start=$(date +%s)

while [ "$stop" -eq 0 ] && { [ "$COUNT" -eq 0 ] || [ "$sigs" -lt "$COUNT" ]; }; do
  it_fail=0; it_msgs=(); n=$((sigs+1)); key_checks=0
  if [ $((sigs % KEY_EVERY)) -eq 0 ]; then
    cur_alg=${ALGS[$((alg_i % ${#ALGS[@]}))]}; alg_i=$((alg_i+1))
    new_key "$cur_alg"; key_checks=2
  fi
  d="$WORK/sig"; rm -rf "$d"; mkdir -p "$d"
  mlen=$(( $(rand_u16) % (MAX_MSG+1) ))
  clen=$(( $(rand_u16) % 65 ))
  head -c "$mlen" /dev/urandom > "$d/msg"
  ctx=""; [ "$clen" -gt 0 ] && ctx=$(head -c "$clen" /dev/urandom | od -An -v -tx1 | tr -d ' \n')
  cargs=(); [ -n "$ctx" ] && cargs=(--context-hex "$ctx")
  # alternate per algorithm, so -a both covers both modes for each parameter set
  if [ $(( (${per_alg_sigs[$cur_alg]:-0} + 1) % 2 )) -eq 0 ]; then mode=deterministic; margs=(--deterministic); else mode=hedged; margs=(); fi

  if "$BIN" sign --sk "$KEYDIR/sk.key" --in "$d/msg" --sig "$d/sig" "${cargs[@]}" "${margs[@]}" >/dev/null 2>&1; then
    ok     "OpenSSL verifies $mode signature" ossl_verify "$KEYDIR/pub.pem" "$d/msg" "$d/sig" "$ctx"
    cp "$d/msg" "$d/msg.bad"; printf 'X' >> "$d/msg.bad"
    reject "modified message" ossl_verify "$KEYDIR/pub.pem" "$d/msg.bad" "$d/sig" "$ctx"
    cp "$d/sig" "$d/sig.bad"; pos=$(( $(rand_u16) % 7856 ))
    byte=$(od -An -j "$pos" -N1 -tu1 "$d/sig.bad" | tr -d ' ')
    printf "$(printf '\\x%02x' $(( byte ^ 1 )))" | dd of="$d/sig.bad" bs=1 seek="$pos" conv=notrunc 2>/dev/null
    reject "signature bit flip at byte $pos" ossl_verify "$KEYDIR/pub.pem" "$d/msg" "$d/sig.bad" "$ctx"
    reject "wrong context" ossl_verify "$KEYDIR/pub.pem" "$d/msg" "$d/sig" "${ctx}00"
    checks=4
    if [ "$mode" = deterministic ]; then
      oopts=(-pkeyopt deterministic:1); [ -n "$ctx" ] && oopts+=(-pkeyopt "hexcontext-string:$ctx")
      openssl pkeyutl -sign -inkey "$KEYDIR/priv.pem" -in "$d/msg" -out "$d/ossl.sig" "${oopts[@]}" >/dev/null 2>&1
      ok "deterministic signature == OpenSSL's" cmp -s "$d/sig" "$d/ossl.sig"
      checks=5
    fi
  else
    it_fail=$((it_fail+1)); it_msgs+=("FAIL: rslh sign"); checks=1
  fi

  # Ctrl-C during this iteration kills child processes; discard its partial results.
  [ "$stop" -eq 1 ] && break

  sigs=$n
  [ "$key_checks" -gt 0 ] && keys=$((keys+1))
  per_alg_sigs[$cur_alg]=$(( ${per_alg_sigs[$cur_alg]:-0} + 1 ))
  total=$((checks + key_checks))
  failed=$((failed + it_fail)); passed=$((passed + total - it_fail))
  if [ "$it_fail" -gt 0 ]; then
    failed_sigs=$((failed_sigs+1))
    keep="$FAILDIR/$(date +%Y%m%d-%H%M%S)-sig$n"; mkdir -p "$keep"
    cp -r "$KEYDIR" "$keep/key"; cp -r "$d"/. "$keep/"; echo "$ctx" > "$keep/context.hex"
    printf '%s\n' "${it_msgs[@]}" > "$keep/failures.txt"
    printf "  #%-6d %-18s %-13s FAILED: %s (kept in %s)\n" "$n" "$(alg_name "$cur_alg")" "$mode" \
      "$(IFS=';'; echo "${it_msgs[*]}")" "$keep"
    [ "$STOP_ON_FAIL" -eq 1 ] && break
  elif [ "$QUIET" -eq 0 ] || [ $((n % 10)) -eq 0 ]; then
    el=$(( $(date +%s) - start ))
    printf "  #%-6d %-18s %-13s msg %4d B  ctx %2d B  ok   [%d checks, %d failed, %ds]\n" \
      "$n" "$(alg_name "$cur_alg")" "$mode" "$mlen" "$clen" "$passed" "$failed" "$el"
  fi
done

el=$(( $(date +%s) - start ))
echo
[ "$stop" -eq 1 ] && echo "interrupted."
echo "signatures checked: $sigs  ($(for a in "${ALGS[@]}"; do printf '%s=%d ' "$a" "${per_alg_sigs[$a]:-0}"; done| sed 's/ $//'))"
echo "key pairs:          $keys"
echo "checks:             $passed passed, $failed failed  (failing signatures: $failed_sigs)"
echo "time:               ${el}s$( [ "$sigs" -gt 0 ] && awk "BEGIN{printf \"  (%.2f s/signature)\", $el/$sigs}")"
if [ "$failed" -eq 0 ] && [ "$sigs" -gt 0 ]; then echo "RESULT: PASS"; exit 0
elif [ "$sigs" -eq 0 ]; then echo "RESULT: nothing checked"; exit 2
else echo "RESULT: FAIL"; exit 1; fi
