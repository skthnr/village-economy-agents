# eidolon

A 19-agent village economy running on NEAR. Every villager is an on-chain
actor with a wallet, an inventory, a body, a job, and a daily routine; a
deterministic tick resolves their submitted actions, production, spoilage,
taxes, and market settlement. Items are a **NEP-245 multi-token**
(`MultiToken` derive: NEP-245 core, metadata, NEP-145 storage) whose token ids
are the 18 village goods. Coin is a **NEP-141 fungible token** with a fixed
supply and `decimals: 0`.

This repository is an executable spec: the contracts, the scripted agents, and
the test suite are the documentation. See [ATTRIBUTION.md](ATTRIBUTION.md) for
the origin disclosure and the pinned upstream revision.

## Architecture

| Component | Account | Responsibility |
|---|---|---|
| `contracts/world` (`eidolon-world`) | `world.eidolon.testnet` | World state, tick, production, market escrow, mirrors, NEP-297 events, views |
| `contracts/items` (`eidolon-items`) | `items.eidolon.testnet` | NEP-245 item tokens; world is the owner and sole minter/burner |
| `contracts/coin` (`eidolon-coin`) | `coin.eidolon.testnet` | NEP-141 coin; fixed supply minted to world at init, transfers only |
| `orchestrator/` | off-chain | Fetches perception, chooses scripted or LLM actions, submits them, calls `run_tick` |

The world contract never reads token balances during view calls. It maintains
`coin_balance_mirror` and `item_balance_mirror`, updated by the callbacks and
cross-contract flows that own every balance change.

### Simulation rules

- 16 ticks per day, 7 days per season, 112 ticks per season; tick 1 is
  `Monday, 06:00`, spring, day 1. One tick is one simulated hour.
- Recipes, season multipliers, satiation, spoilage, tool wear, hunger, tax, and
  the initial price index are ported from the origin tables.
- Order ids are `(tick << 20) | seq`; fill ids are `(tick << 20) | next_fill_seq`.
- The origin random sleep roll is replaced by
  `((tick / 16) * 19 + agent_index) % 100`. There is no RNG and no wall clock in
  the engine path. Two runs over the same inputs produce the same state.

## Quickstart

The demo needs only Node.js: it starts a local `near-sandbox` chain, deploys
the release contracts, and runs 19 scripted agents for 49 ticks with zero real
funds, no faucet, and no API keys.

```bash
npm install
npm run demo
```

`npm run demo` prints one snapshot per simulated day. `npm run measure` runs
the same 49-tick workload and prints gas and wall-clock per tick. `npm test`
runs the unit, legacy-vector, relayer, and 49-tick simulation suites.

Contract build (needs Rust, `cargo-near`, and `near-cli-rs`):

```bash
(cd contracts/items && cargo near build non-reproducible-wasm)
(cd contracts/coin && cargo near build non-reproducible-wasm)
(cd contracts/world && cargo near build non-reproducible-wasm)
cp .env.example .env
# edit .env, then
bash scripts/deploy.sh
```

`scripts/deploy.sh` builds and deploys items, coin, and world in that order,
initializes each contract, and prints the storage-registration commands that
follow. The orchestrator target API is documented by the contract signatures:
`get_perception`, `submit_actions`, and `run_tick` on the world contract; the
relayer path is a later wave.

## Dry-run demo

The default run is 49 ticks (three simulated days); set
`EIDOLON_TICKS=112` for a full seven-day season. The output below is from the
W4 measurement run on Ubuntu 24.04, one vCPU (numbers vary by host):

```text
eidolon demo: 19 agents, 49 ticks, zero real funds, scripted policy
day 1: wealth=642 gini_bps=3848 gdp=0 scarce=meat,medicine
day 2: wealth=642 gini_bps=3848 gdp=0 scarce=meat,medicine
day 3: wealth=642 gini_bps=3848 gdp=0 scarce=meat,medicine
day 4: wealth=642 gini_bps=3848 gdp=0 scarce=meat,medicine
demo complete: 4 dawn snapshots, 49 ticks
```

Measured with `npm run measure` on the same host:

```text
49 ticks in 71.51s; 30.44 Tgas/tick (ubuntu-latest, 2026-11-12)
storage: 1635400 bytes across world/items/coin
```

The gas figure is the sum of `receipts_outcome[].outcome.gas_burnt` over the
49 tick transactions; storage is `view_account.storage_usage` summed over the
world, items, and coin accounts.

A second run on the same host completed in 71.77 s with the same
30.44 Tgas/tick and 1,635,400 bytes, confirming the deterministic gas count.

The demo and measurement scripts are `demo.mjs` and `scripts/measure.mjs`;
both import the same `tests/demo-runner.mjs` loop, so the measured workload is
the demo workload.


## Environment variables

| Variable | Meaning |
|---|---|
| `WORLD_ACCOUNT` | World contract account id |
| `ITEMS_ACCOUNT` | Items contract account id |
| `COIN_ACCOUNT` | Coin contract account id |
| `NEAR_NETWORK` | `testnet` or `mainnet` |
| `NEAR_RPC_URL` | JSON-RPC endpoint used by the orchestrator |
| `RELAYER_URL` | NEP-366 relayer endpoint |
| `RELAYER_ACCOUNT` | Relayer account id |
| `RELAYER_PRIVATE_KEYS` | Comma-separated relayer keys (secret; env only) |
| `NEAR_AI_API_KEY` | NEAR AI Cloud API key (secret; env only) |
| `NEAR_AI_BASE_URL` | OpenAI-compatible gateway base URL |
| `NEAR_AI_MODEL` | Model id for NPC decisions |
| `WORLD_OWNER_KEY` | World owner secret key used to call `run_tick` |
| `AGENT_KEYSTORE_DIR` | Directory for generated NPC keys (gitignored) |
| `EIDOLON_TICKS` | Demo/measure horizon (default 49) |

`.env` and `.keys/` are gitignored. No secret value belongs in a tracked file.

## Scope

Implemented by this spec:

- NEP-245 items with owner-gated mint/burn and NEP-145 storage
- NEP-141 fixed-supply coin
- World state, recipe/economy tables, deterministic time and body helpers,
  event enum, genesis initialization, and state-local views
- Deterministic scripted NPC policy and an optional NEAR AI Cloud policy
- Direct action submission and owner-invoked tick execution

Deferred from the hackathon build, deliberately:

- Village meetings, proposals, votes, and laws
- God mode, scenario harness, and world generation
- Multi-village travel and player-controlled agents
- Loans, hired labor, wages, and barter scanning

The port covers the shipped economy only. The unmodified origin snapshot is
not part of this repository.

## Platform limits

NEAR sandbox binaries support Linux x86_64, Linux aarch64, and macOS arm64 only;
Windows and Intel macOS throw `Unsupported platform`. On Windows, run the test
and demo suites inside WSL2 or on a Linux CI runner. Contract builds only need
the Rust toolchain and do not require a sandbox. Node 22 is the pinned
maintenance LTS line.

## Attribution

This is a fork-derived port of an MIT-licensed origin project. The repository
URL, pinned commit `e0656ca`, tree `801af5c`, and the itemized reuse are in
[ATTRIBUTION.md](ATTRIBUTION.md).

## License

MIT. See [LICENSE](LICENSE).
