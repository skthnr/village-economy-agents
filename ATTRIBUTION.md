# Attribution

## Origin project

- Repository: https://github.com/marcopatzelt/brunnfeld-agentic-world
- Author: Marco Patzelt
- License: MIT
- Pinned commit: `e0656ca`
- Pinned tree: `801af5c`
- Snapshot date recorded by this project: 2026-04-06 (`main`)

`origin/` holds the complete origin snapshot as an unmodified oracle copy.
No file inside `origin/` is edited, regenerated, or deleted.
The copy supports comparison with the original simulation.
It also keeps the MIT notice with the reused material.

## What is reused

- Village simulation design: tick loop phases, body/hunger model, seasons, weather, tools, spoilage, tax, and the deterministic scripted fallback policy.
- The 18-recipe supply-chain economy and its season multipliers.
- The 19-agent village seed (names, skills, homes, work locations, schedules, starting wallets, and inventories).
- The React viewer from `origin/viewer/` (forked in a later wave; a chain polling hook replaced its SSE data hook).

## What is new

`contracts/`, `orchestrator/`, `tests/`, and `scripts/` form a new NEAR implementation.
It provides NEP-245 item tokens, a NEP-141 coin, the on-chain world state machine, deterministic tick settlement, and the off-chain orchestrator that submits actions and calls `run_tick`.

## License

This repository uses the MIT license in `LICENSE`.
It preserves the origin copyright line and adds the eidolon contributors line.
Third-party dependencies keep their own licenses.
`near-sdk` 5.30.1 is `MIT OR Apache-2.0`, used here under MIT.
`near-sdk-contract-tools` 4.0.0 is `GPL-3.0 OR Apache-2.0`, used here under Apache-2.0.
