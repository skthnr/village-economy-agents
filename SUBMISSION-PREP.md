# SUBMISSION-PREP — eidolon (LOCAL DRAFT, NOT SUBMITTED)

Tracks: `games`, `agents` (specs `p0-games.md`, `p0-agents.md`). Deadline 2026-11-14T23:59:00Z.
No push, no remote, no tags, no X post, no submit. Local commit only.

## Judge quickstart (do X -> see Y), MEASURED on Celesto Box A

```
cargo test --workspace     -> 31 passed (0.16s; rustc 1.100.0, near-sdk 5.30.2)
cargo build --target wasm32-unknown-unknown --release -> EXIT 0
cargo near build non-reproducible-wasm -> EXIT 0, deployable 596,451 B
tsc                        -> 0 errors / 0 warnings (EXIT 0 both)
npm test                   -> 26 tests / 26 pass / 0 fail, RC=0
offline suite              -> 24/24
env EIDOLON_DET_TICKS=112 npm test -> 2/2 determinism
golden digest assertion    -> EXIT 0
112-tick digest=30271fa8011c33c045f3577ada4bd9a9b722fd0a82bbd435f72c55222ef9b46f
storage 629,209 B; gas 27.98 Tgas/tick; 49 ticks in 76.41s
```

`cdylib`-only crates give 176,164 B (items), 138,149 B (coin), and 282,138 B (world). That cuts deployable WASM by 19.2%, from 738,263 B to 596,451 B. `/mnt/d` returns EXDEV (`Invalid cross-device link`) with RC=1. ext4 returns RC=0. `ozall` gives 279,900 B with ABI 36/18, and runtime parity stays held. Variants pass 140/140.

## Recordable demo outline (human records, human posts)

1. Show a villager wallet holding an NEP-245 inventory token and NEP-141 coin.
2. Advance one deterministic tick: production, spoilage, tax, market settlement, and the resulting balance change. One moment, visible result.

Q-012 video required when judges cannot open the demo. Tags @NEARProtocol, #NEARHackathon. Main writes no post.

## Payload fields — ALL EMPTY, human supplies every value

| Field | Rule | Value |
|---|---|---|
| requestId | UUID, generated ONCE, reused on 400/503 | EMPTY |
| projectName | 2-80 chars | EMPTY |
| leadName | 2-80 chars | EMPTY |
| email | valid, <=160, max 2 submissions per address (Q-015) | EMPTY |
| size | `1` / `2 - 4` / `4 - 6` / `6 - 8` / `8+` | EMPTY |
| tracks | >=1 track id, each once, `games` and `agents` fit | EMPTY |
| nearAddress | 2-64 lowercase mainnet account the team creates | EMPTY |
| projectUrl | http(s), <=300, public repo, unique | EMPTY |
| demoUrl | http(s), <=300, published X post | EMPTY |
| idea | 20-2000 chars | EMPTY |
| consent | `true` only after verbatim notice + human yes | EMPTY |

Never add `website`. Print full JSON, wait for explicit yes. 201 saved. On 400 fix `fields` and reuse the requestId. On 403 stop. On 409 stop. On 413 shorten. On 503 retry the same requestId.

## Rules checklist

- Q-003: 8 pre-existing tags, none of the required pair, and no README diff link. Not satisfied. Local tags deliberately not created.
- Q-012: video required when judges cannot open the demo.
- Q-014: `LICENSE` present. Q-017: README "Quickstart" at line 88 and "Dry-run demo" at line 112.
- Q-015: a second project on the same email must be named in README. Unresolved.
- Q-002/Q-005 disclosure: README "Attribution and license" at line 153.
- W8: dRPC N=2/3 returns 200. N=4 returns 400 code 31. Core `-32700` holds for that state only. No unbounded speedup claim.
- HELD: single-suite consolidation prototyped then reverted (cold wall 572.3 vs 597.7 ms, no gain) per net-positive ROI.

## Blockers (none open)

Celesto credit, Firecrawl credits, and Exa 402 are resolved on Box A. `WAVE-3-eidolon.md` §7 keeps the exact credit line. BoxLite §6 MEASURED `p6ieTxSadkD2`.

## Attestation

Nothing is published, pushed, tagged, or submitted. No payload value is invented.
