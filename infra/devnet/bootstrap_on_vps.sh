#!/usr/bin/env bash
# Generate private validator material on a fresh target host without transferring keys.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
if [[ $(id -u) != 0 ]]; then
  echo "Run this one-time wrapper as root; it runs generation as the deployment user." >&2
  exit 1
fi
: "${QSW_RUN_USER:=research}"
: "${QSW_PREFUND_ADDRESS:?Set the public prefunded deployer address}"
: "${QSW_KURTOSIS:?Set the verified Kurtosis 1.22.2 binary path}"
: "${QSW_MNEMONIC_IMAGE:=qsw-sidecar:2e22ff0a-pq-v1}"
if [[ -n $(docker ps -aq --filter name=kurtosis) ]]; then
  echo "Existing Kurtosis infrastructure found; use an isolated bootstrap host." >&2
  exit 1
fi
if docker ps --format '{{.Ports}}' | grep -Eq '0\.0\.0\.0:|\[::\]:|:::'; then
  echo "Existing externally published Docker ports found; refusing to alter their access." >&2
  exit 1
fi
if [[ -d infra/devnet/.generated/bundle ]]; then
  echo "A sealed bundle already exists; refusing a new identity." >&2
  exit 1
fi
interface=$(ip -o route show default | awk 'NR==1 {print $5}')
[[ -n "$interface" ]]
enclave="qsw-vps-bootstrap-host-$(date +%s)-$RANDOM"
comment="$enclave"
log="$(pwd)/infra/devnet/.generated/bootstrap-host.private.log"
mkdir -p infra/devnet/.generated
chmod 700 infra/devnet/.generated
cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  # The initial guard proved there was no pre-existing Kurtosis instance.
  # Stop the coordinator we created before making any temporary ports reachable.
  XDG_CONFIG_HOME="$(pwd)/infra/devnet/.generated/kurtosis-config" \
    "$QSW_KURTOSIS" enclave rm "$enclave" --force >>"$log" 2>&1 || true
  mapfile -t enclave_ids < <(docker ps -q --filter "label=com.kurtosistech.enclave-name=$enclave")
  if (( ${#enclave_ids[@]} )); then docker stop "${enclave_ids[@]}" >>"$log" 2>&1 || true; fi
  XDG_CONFIG_HOME="$(pwd)/infra/devnet/.generated/kurtosis-config" \
    "$QSW_KURTOSIS" engine stop >>"$log" 2>&1 || true
  # These coordinators are ours: the wrapper refused any pre-existing instance.
  mapfile -t coordinator_ids < <(docker ps -q --filter name=kurtosis)
  if (( ${#coordinator_ids[@]} )); then docker stop "${coordinator_ids[@]}" >>"$log" 2>&1 || true; fi
  if [[ -n $(docker ps -q --filter "label=com.kurtosistech.enclave-name=$enclave") || -n $(docker ps -q --filter name=kurtosis) ]]; then
    echo "Bootstrap cleanup needs attention; temporary ingress protection retained." >&2
    exit 1
  fi
  iptables -D DOCKER-USER -i "$interface" -m conntrack --ctstate NEW \
    -m comment --comment "$comment" -j DROP || true
  exit "$status"
}
trap cleanup EXIT INT TERM HUP
# Only bootstrap-time Docker ingress is affected: no pre-existing public Docker
# service passed the guard. Host SSH and the loopback Cloudflare origin continue.
iptables -I DOCKER-USER 1 -i "$interface" -m conntrack --ctstate NEW \
  -m comment --comment "$comment" -j DROP
chown "$QSW_RUN_USER:$QSW_RUN_USER" infra/devnet/.generated
sudo -u "$QSW_RUN_USER" python3 infra/devnet/bootstrap.py \
  --prefund-address "$QSW_PREFUND_ADDRESS" --prefund-eth 1000 \
  --kurtosis "$QSW_KURTOSIS" --mnemonic-image "$QSW_MNEMONIC_IMAGE" --enclave "$enclave"
