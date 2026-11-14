# eidolon

19 agents run a village economy on NEAR. Each villager holds a wallet, an inventory, a body, a job, and a daily routine. One deterministic tick resolves actions, production, spoilage, tax, and market settlement. Items are NEP-245 tokens (`MultiToken` derive: NEP-245 core, metadata, NEP-145 storage). Token ids are the 18 village goods. Coin is a NEP-141 fungible token with fixed supply and `decimals: 0`. This repository is an executable specification of contracts, scripted agents, and tests. [ATTRIBUTION.md](ATTRIBUTION.md) gives the origin and the pinned upstream revision.

```mermaid
sequenceDiagram
    accTitle: eidolon runtime flow
    accDescr: Orchestrator deploys both contracts, creates agent accounts, then perceives, decides, submits actions, settles the market, and rolls ticks.
    autonumber
    box rgba(243,232,255,0.12) Contracts
    participant W as world
    participant I as items
    participant K as coin
    end
    box rgba(230,247,235,0.12) Off-chain agents
    participant O as orchestrator
    participant R as relayer
    end
    box rgba(255,244,214,0.12) Local chain
    participant S as sandbox
    end
    rect rgba(226,238,255,0.20)
    Note over O,S: PHASE 1 — Deploy and init contracts
    O->>S: near-sandbox start
    O->>I: new(owner_id)
    O->>K: new(owner_id, total_supply)
    O->>W: new(items_contract, coin_contract, seed_agents)
    end
    rect rgba(230,247,235,0.20)
    Note over O,W: PHASE 2 — Create agent accounts
    O->>+W: create_agent_with_keys(name, fck_key, market_key)
    W-->>-O: sub-account created
    end
    rect rgba(255,244,214,0.20)
    Note over O,W: PHASE 3 — Perceive each agent
    loop each tick until horizon
    par one view per agent
    O->>+W: get_perception(agent_id)
    W-->>-O: perception prompt
    end
    O->>O: parsePerception
    end
    end
    rect rgba(243,232,255,0.20)
    Note over O: PHASE 4 — Decide via resolvePolicyMode
    activate O
    O->>O: decideActions or decideWithLlm
    deactivate O
    end
    rect rgba(255,232,232,0.20)
    Note over O,R: PHASE 5 — Act and submit
    par one submit per agent
    alt relayer configured
    O->>R: relayCoreActions(signed delegate)
    R->>W: submit_actions(actions)
    else direct submission
    O->>W: submit_actions(actions)
    end
    end
    end
    rect rgba(224,247,250,0.20)
    Note over O,K: PHASE 6 — Clear the market
    O->>W: post_order(item, quantity, price)
    alt sell side
    O->>I: mt_transfer_call(sell price)
    I->>W: mt_on_transfer
    else buy side
    O->>K: ft_transfer_call(buy order id)
    K->>+W: ft_on_transfer
    W->>I: mt_transfer(buyer, item)
    W->>W: on_buy_fill
    W-->>-K: unused amount
    end
    end
    rect rgba(255,248,225,0.20)
    Note over O,W: PHASE 7 — Roll tick and season
    O->>W: run_tick()
    activate W
    opt first tick of day
    W->>W: dawn_phase, season_for_tick, weather_for
    end
    deactivate W
    end
```

## Architecture

| Component | Account | Responsibility |
|---|---|---|
| `contracts/world` (`eidolon-world`) | `world.eidolon.testnet` | World state, tick, production, market escrow, mirrors, NEP-297 events, views |
| `contracts/items` (`eidolon-items`) | `items.eidolon.testnet` | NEP-245 item tokens. World owns, mints, and burns them |
| `contracts/coin` (`eidolon-coin`) | `coin.eidolon.testnet` | NEP-141 coin. Init mints a fixed supply to world. Transfers only |
| `orchestrator/` | off-chain | Fetches perception, chooses scripted or LLM actions, submits them, calls `run_tick` |

Views do not read token balances. `coin_balance_mirror` and `item_balance_mirror` record every balance change, and callbacks and cross-contract flows own all balance updates. Deployed WASM sizes are 176,164 B (items), 138,149 B (coin), and 282,138 B (world).

## Simulation rules

- 16 ticks per day, 7 days per season, 112 ticks per season. Tick 1 is `Monday, 06:00`, spring, day 1. One tick is one simulated hour. The engine uses no RNG and no wall clock, so identical inputs produce identical state.
- Recipes, season multipliers, satiation, spoilage, tool wear, hunger, tax, and initial prices match the origin tables.
- Order ids use `(tick << 20) | seq`. Fill ids use `(tick << 20) | next_fill_seq`.
- The sleep roll is `((tick / 16) * 19 + agent_index) % 100`.

## Quickstart

```bash
npm install
npm run demo
```

The demo needs only Node.js. It starts a local `near-sandbox` chain and deploys release contracts. It runs 19 scripted agents for 49 ticks with zero real funds, no faucet, and no API keys. `npm run demo` prints one snapshot per simulated day. `npm run measure` runs the 49-tick workload and prints gas and wall time per tick. `npm test` runs the unit, vector, relayer, 49-tick simulation, and 112-tick determinism suites. Contract builds need Rust, `cargo-near`, and `near-cli-rs`:

```bash
(cd contracts/items && cargo near build non-reproducible-wasm)
(cd contracts/coin && cargo near build non-reproducible-wasm)
(cd contracts/world && cargo near build non-reproducible-wasm)
cp .env.example .env
# edit .env, then
bash scripts/deploy.sh
```

`scripts/deploy.sh` builds and deploys items, coin, and world in sequence, initializes each contract, and prints storage commands. Orchestrator targets are `get_perception`, `submit_actions`, and `run_tick`. The demo horizon defaults to 49 ticks (three simulated days); `EIDOLON_TICKS=112` runs a seven-day season.

## Dry-run demo

```text
eidolon demo: 19 agents, 49 ticks, zero real funds, scripted policy
day 1: wealth=642 gini_bps=3848 gdp=0 scarce=meat,medicine
day 2: wealth=642 gini_bps=3848 gdp=0 scarce=meat,medicine
day 3: wealth=642 gini_bps=3848 gdp=0 scarce=meat,medicine
day 4: wealth=642 gini_bps=3848 gdp=0 scarce=meat,medicine
demo complete: 4 dawn snapshots, 49 ticks
```

`npm run measure` on a single-vCPU Ubuntu 24.04 host gives:

```text
49 ticks in 76.41s; 27.98 Tgas/tick
storage: 629,209 B across world/items/coin
```

Gas sums `receipts_outcome[].outcome.gas_burnt` over 49 ticks. Storage sums `view_account.storage_usage` across world, items, and coin. `demo.mjs` and `scripts/measure.mjs` import `tests/demo-runner.mjs`, so both measure identical work.

## Environment variables

`.env.example` lists every variable: `WORLD_ACCOUNT`, `ITEMS_ACCOUNT`, and `COIN_ACCOUNT` name the deployed contracts; `NEAR_NETWORK` is `testnet` or `mainnet`; `NEAR_RPC_URL` is the orchestrator JSON-RPC endpoint; `RELAYER_URL` is the NEP-366 relayer endpoint and `RELAYER_ACCOUNT` its account id; `NEAR_AI_BASE_URL` is the OpenAI-compatible gateway and `NEAR_AI_MODEL` the NPC decision model; `AGENT_KEYSTORE_DIR` holds generated NPC keys; `EIDOLON_TICKS` sets the demo/measure horizon (default 49). `RELAYER_PRIVATE_KEYS`, `NEAR_AI_API_KEY`, and `WORLD_OWNER_KEY` (calls `run_tick`) are secrets: `.env` and `.keys/` are gitignored, and no secret value belongs in a tracked file.

## Scope

Supported surface: NEP-245 items with owner-gated mint, burn, and NEP-145 storage; a NEP-141 fixed-supply coin; world state, economy tables, deterministic time and body rules, events, genesis init, and views; a deterministic scripted NPC policy and an optional NEAR AI Cloud policy; direct action submission and owner-invoked tick execution. Not included: village meetings, proposals, votes, laws, god mode, the scenario harness, world generation, multi-village travel, player-controlled agents, loans, hired labor, wages, and barter scanning.

## Platform limits

NEAR sandbox binaries support Linux x86_64, Linux aarch64, and macOS arm64. Windows and Intel macOS throw `Unsupported platform`, so run tests and demos inside WSL2 or Linux CI. Contract builds need only Rust. Node 26 is the pinned LTS line.

## Attribution and license

This port derives from an MIT-licensed origin project. See [ATTRIBUTION.md](ATTRIBUTION.md) for commit `e0656ca`, tree `801af5c`, and itemized reuse. The repository uses the MIT license in [LICENSE](LICENSE). Hackathon tracks: `games`, `agents`.
