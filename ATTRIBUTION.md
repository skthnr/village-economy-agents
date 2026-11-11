# Attribution

## Origin project

- Repository: https://github.com/marcopatzelt/brunnfeld-agentic-world
- Author: Marco Patzelt
- License: MIT
- Pinned commit: `e0656ca`
- Pinned tree: `801af5c`
- Snapshot date recorded by this project: 2026-04-06 (`main`)

The complete origin snapshot is committed under `origin/` and is an unmodified
oracle copy: no file inside `origin/` is edited, regenerated, or deleted by this
project. It is kept so the port can be compared against the original simulation
and so the MIT notice travels with the reused material.

## What is reused

- The village simulation design: tick loop phases, body/hunger model, seasons,
  weather, tools, spoilage, tax, and the deterministic scripted fallback policy.
- The 18-recipe supply-chain economy and its season multipliers.
- The 19-agent village seed (names, skills, homes, work locations, schedules,
  starting wallets, and inventories).
- The React viewer from `origin/viewer/` (forked in a later wave, with its SSE
  data hook replaced by a chain polling hook).

## What is new

Everything under `contracts/`, `orchestrator/`, `tests/`, and `scripts/` is a new
NEAR implementation: NEP-245 item tokens, a NEP-141 coin, the on-chain world
state machine, deterministic tick settlement, and the off-chain orchestrator
that submits actions and calls `run_tick`.

## License

This repository is distributed under the MIT license in `LICENSE`, preserving
the origin copyright line and adding the eidolon contributors line.

Third-party dependencies keep their own licenses. `near-sdk` 5.30.1 is
`MIT OR Apache-2.0`, used here under MIT. `near-sdk-contract-tools` 4.0.0 is
`GPL-3.0 OR Apache-2.0`, used here under Apache-2.0.
