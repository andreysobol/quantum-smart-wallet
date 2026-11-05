#!/bin/sh
set -eu
# Advertise only this container's own private address, never the bootstrap IP.
set -- $(hostname -i)
address="$1"
exec lighthouse beacon_node \
  --debug-level=info --datadir=/data --testnet-dir=/network-configs \
  --listen-address=0.0.0.0 --port=9000 --http --http-address=0.0.0.0 --http-port=5052 \
  --disable-packet-filter --disable-enr-auto-update --enr-address="$address" \
  --enr-tcp-port=9000 --enr-udp-port=9000 --enr-quic-port=9001 --quic-port=9001 \
  --enable-private-discovery --execution-endpoints=http://ethrex:8551 \
  --jwt-secrets=/jwt/jwtsecret --suggested-fee-recipient="$QSW_FEE_RECIPIENT" \
  --supernode --allow-insecure-genesis-sync --target-peers=0
