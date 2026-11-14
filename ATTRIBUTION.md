# Attribution

## Origin project

- Repository: https://github.com/marcopatzelt/brunnfeld-agentic-world
- Author: Marco Patzelt
- License: MIT
- Pinned commit: `e0656ca`
- Pinned tree: `801af5c`
- Snapshot date recorded by this project: 2026-04-06 (`main`)

`origin/` holds the unmodified upstream copy as an oracle, leaves files in `origin/` untouched, and preserves the MIT notice.

## What is reused

- Simulation design: tick loop, body model, seasons, weather, tools, spoilage, tax, and scripted policy.
- The 18-recipe supply-chain economy and season multipliers.
- The 19-agent village seed (names, skills, locations, schedules, wallets, and inventories).
- The React viewer from `origin/viewer/` (forked later with chain polling replacing SSE).

## What is new

`contracts/`, `orchestrator/`, `tests/`, and `scripts/` implement the NEAR port.
They provide NEP-245 item tokens, NEP-141 coin, on-chain world state, deterministic tick settlement, and the off-chain orchestrator that submits actions and calls `run_tick`.

## License

This repository uses the MIT license in `LICENSE` with the origin copyright and eidolon contributor lines.
Third-party dependencies keep their own licenses.
`near-sdk` 5.30.2 is `MIT OR Apache-2.0`, used here under MIT.
`near-sdk-contract-tools` 4.0.0 is `GPL-3.0 OR Apache-2.0`, used here under Apache-2.0.
