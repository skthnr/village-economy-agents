# eidolon

A 19-agent village economy running on NEAR. Every villager is an on-chain
actor with a wallet, an inventory, a body, a job, and a daily routine; a
deterministic tick resolves their submitted actions, production, spoilage,
taxes, and market settlement. Items are a **NEP-245 multi-token**
(`MultiToken` derive: NEP-245 core, metadata, NEP-145 storage) whose token ids
are the 18 village goods. Coin is a **NEP-141 fungible token** with a fixed
supply and `decimals: 0`.

This repository is an executable spec. The origin simulation is kept unmodified
under `origin/` as an oracle; see [ATTRIBUTION.md](ATTRIBUTION.md).

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

Prerequisites:

- Rust 1.95 or newer with the `wasm32-unknown-unknown` target
- `cargo-near` 0.23.0 and `near-cli-rs` 0.31.1
- Node.js 22.22.2 or newer and pnpm 10.4.1 or newer

```bash
npm install
npm test
```

Contract build and deploy:

```bash
(cd contracts/items && cargo near build)
(cd contracts/coin && cargo near build)
(cd contracts/world && cargo near build)
cp .env.example .env
# edit .env, then
bash scripts/deploy.sh
```

`scripts/deploy.sh` builds and deploys items, coin, and world in that order,
initializes each contract, and prints the storage-registration commands that
follow. The orchestrator target API is documented by the contract signatures:
`get_perception`, `submit_actions`, and `run_tick` on the world contract; the
relayer path is a later wave.

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
| `TICKS` | Default run horizon |

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

`origin/` retains these features for reference and is not part of the port.

## Platform limits

NEAR sandbox binaries support Linux x86_64, Linux aarch64, and macOS arm64 only;
Windows and Intel macOS throw `Unsupported platform`. On Windows, run the test
and demo suites inside WSL2 or on a Linux CI runner. Contract builds only need
the Rust toolchain and do not require a sandbox. Node 22 is the pinned
maintenance LTS line.

## Origin disclosure

This is a fork-derived port of the MIT origin project documented in
[ATTRIBUTION.md](ATTRIBUTION.md) (repository URL, pinned commit `e0656ca`, tree
`801af5c`, and reuse itemized there). The unmodified snapshot lives in `origin/`.

## License

MIT. See [LICENSE](LICENSE).
