#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat >&2 <<'USAGE'
usage: scripts/deploy.sh

Required environment:
  WORLD_ACCOUNT     world contract account id
  ITEMS_ACCOUNT     items contract account id
  COIN_ACCOUNT      coin contract account id
  NEAR_NETWORK      testnet or mainnet
  WORLD_OWNER_KEY   world owner secret key (used by the orchestrator)

Run from the repository root after copying .env.example to .env.
USAGE
  exit 1
}

for name in WORLD_ACCOUNT ITEMS_ACCOUNT COIN_ACCOUNT NEAR_NETWORK WORLD_OWNER_KEY; do
  if [ -z "${!name:-}" ]; then
    printf 'missing required environment variable: %s\n' "$name" >&2
    usage
  fi
done

SEED_AGENTS_JSON=$(cat "$ROOT/scripts/seeds.json")

ITEMS_INIT_ARGS=$(printf '{"owner_id":"%s"}' "$WORLD_ACCOUNT")
COIN_INIT_ARGS=$(printf '{"owner_id":"%s","total_supply":"1000000","metadata":{"spec":"ft-1.0.0","name":"eidolon coin","symbol":"COIN","decimals":0}}' "$WORLD_ACCOUNT")
WORLD_INIT_ARGS=$(printf '{"items_contract":"%s","coin_contract":"%s","seed_agents":%s}' "$ITEMS_ACCOUNT" "$COIN_ACCOUNT" "$SEED_AGENTS_JSON")

(
  cd "$ROOT/contracts/items"
  cargo near deploy build-non-reproducible-wasm "$ITEMS_ACCOUNT" \
    with-init-call new json-args "$ITEMS_INIT_ARGS" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
    network-config "$NEAR_NETWORK" sign-with-keychain send
)

(
  cd "$ROOT/contracts/coin"
  cargo near deploy build-non-reproducible-wasm "$COIN_ACCOUNT" \
    with-init-call new json-args "$COIN_INIT_ARGS" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
    network-config "$NEAR_NETWORK" sign-with-keychain send
)

(
  cd "$ROOT/contracts/world"
  cargo near deploy build-non-reproducible-wasm "$WORLD_ACCOUNT" \
    with-init-call new json-args "$WORLD_INIT_ARGS" \
    prepaid-gas "$((300)) Tgas" attached-deposit '0 NEAR' \
    network-config "$NEAR_NETWORK" sign-with-keychain send
)

printf '\nContracts deployed. Register the world on both token contracts next:\n\n'
echo "near contract call-function as-transaction $ITEMS_ACCOUNT storage_deposit json-args '{\"account_id\":\"$WORLD_ACCOUNT\",\"registration_only\":true}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $WORLD_ACCOUNT network-config $NEAR_NETWORK sign-with-keychain send"
echo "near contract call-function as-transaction $COIN_ACCOUNT storage_deposit json-args '{\"account_id\":\"$WORLD_ACCOUNT\",\"registration_only\":true}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $WORLD_ACCOUNT network-config $NEAR_NETWORK sign-with-keychain send"
printf '\nWORLD_OWNER_KEY stays in the orchestrator environment; cargo-near signs with the keychain.\n'
