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

SEED_AGENTS_JSON=$(cat <<'JSON'
[
  {"name":"hans","profile":{"skill":"farmer","home":"Cottage 1","work":"Farm 1","work_start":6,"work_end":16,"wallet":30,"inventory":[["wheat",8]],"tool":"iron_tools","tool_durability":80}},
  {"name":"ida","profile":{"skill":"none","home":"Cottage 2","work":"Cottage 2","work_start":6,"work_end":21,"wallet":12,"inventory":[["cloth",2]],"tool":null,"tool_durability":0}},
  {"name":"konrad","profile":{"skill":"cattle","home":"Farm 2","work":"Farm 2","work_start":6,"work_end":15,"wallet":40,"inventory":[["milk",3],["meat",2]],"tool":"iron_tools","tool_durability":90}},
  {"name":"ulrich","profile":{"skill":"farmer","home":"Cottage 4","work":"Farm 3","work_start":6,"work_end":16,"wallet":20,"inventory":[["vegetables",4]],"tool":"iron_tools","tool_durability":70}},
  {"name":"bertram","profile":{"skill":"farmer","home":"Cottage 5","work":"Farm 1","work_start":6,"work_end":16,"wallet":15,"inventory":[["wheat",5]],"tool":"iron_tools","tool_durability":60}},
  {"name":"gerda","profile":{"skill":"miller","home":"Mill","work":"Mill","work_start":7,"work_end":16,"wallet":45,"inventory":[["flour",4]],"tool":null,"tool_durability":0}},
  {"name":"anselm","profile":{"skill":"baker","home":"Bakery","work":"Bakery","work_start":6,"work_end":13,"wallet":32,"inventory":[["bread",6],["flour",2]],"tool":null,"tool_durability":0}},
  {"name":"volker","profile":{"skill":"blacksmith","home":"Forge","work":"Forge","work_start":7,"work_end":16,"wallet":60,"inventory":[["iron_ore",4],["coal",3]],"tool":null,"tool_durability":0}},
  {"name":"wulf","profile":{"skill":"carpenter","home":"Carpenter Shop","work":"Carpenter Shop","work_start":7,"work_end":16,"wallet":35,"inventory":[["timber",5]],"tool":"iron_tools","tool_durability":75}},
  {"name":"liesel","profile":{"skill":"tavern","home":"Tavern","work":"Tavern","work_start":10,"work_end":21,"wallet":55,"inventory":[["ale",6],["wheat",4]],"tool":null,"tool_durability":0}},
  {"name":"sybille","profile":{"skill":"healer","home":"Healer's Hut","work":"Healer's Hut","work_start":7,"work_end":17,"wallet":28,"inventory":[["herbs",5],["medicine",2]],"tool":null,"tool_durability":0}},
  {"name":"friedrich","profile":{"skill":"woodcutter","home":"Cottage 7","work":"Forest","work_start":6,"work_end":17,"wallet":22,"inventory":[["timber",3],["firewood",6]],"tool":"iron_tools","tool_durability":85}},
  {"name":"otto","profile":{"skill":"none","home":"Elder's House","work":"Elder's House","work_start":6,"work_end":21,"wallet":120,"inventory":[],"tool":null,"tool_durability":0}},
  {"name":"pater_markus","profile":{"skill":"none","home":"Town Hall","work":"Town Hall","work_start":6,"work_end":21,"wallet":25,"inventory":[],"tool":null,"tool_durability":0}},
  {"name":"dieter","profile":{"skill":"miner","home":"Cottage 8","work":"Mine","work_start":7,"work_end":17,"wallet":18,"inventory":[["iron_ore",2],["coal",1]],"tool":"iron_tools","tool_durability":65}},
  {"name":"magda","profile":{"skill":"none","home":"Cottage 8","work":"Village Square","work_start":6,"work_end":21,"wallet":10,"inventory":[["bread",2]],"tool":null,"tool_durability":0}},
  {"name":"heinrich","profile":{"skill":"farmer","home":"Cottage 1","work":"Farm 1","work_start":6,"work_end":16,"wallet":25,"inventory":[["wheat",6],["eggs",3]],"tool":"iron_tools","tool_durability":55}},
  {"name":"elke","profile":{"skill":"seamstress","home":"Seamstress Cottage","work":"Seamstress Cottage","work_start":7,"work_end":16,"wallet":30,"inventory":[["cloth",3]],"tool":null,"tool_durability":0}},
  {"name":"rupert","profile":{"skill":"miner","home":"Cottage 3","work":"Mine","work_start":7,"work_end":17,"wallet":20,"inventory":[["iron_ore",3],["coal",2]],"tool":"iron_tools","tool_durability":80}}
]
JSON
)

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
    prepaid-gas '300 Tgas' attached-deposit '0 NEAR' \
    network-config "$NEAR_NETWORK" sign-with-keychain send
)

printf '\nContracts deployed. Register the world on both token contracts next:\n\n'
echo "near contract call-function as-transaction $ITEMS_ACCOUNT storage_deposit json-args '{\"account_id\":\"$WORLD_ACCOUNT\",\"registration_only\":true}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $WORLD_ACCOUNT network-config $NEAR_NETWORK sign-with-keychain send"
echo "near contract call-function as-transaction $COIN_ACCOUNT storage_deposit json-args '{\"account_id\":\"$WORLD_ACCOUNT\",\"registration_only\":true}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as $WORLD_ACCOUNT network-config $NEAR_NETWORK sign-with-keychain send"
printf '\nWORLD_OWNER_KEY stays in the orchestrator environment; cargo-near signs with the keychain.\n'
