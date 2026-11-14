# SUBMISSION-PREP — eidolon (LOCAL DRAFT, NOT SUBMITTED)

Track: `games` (spec `p0-games.md`). Deadline 2026-11-14T23:59:00Z.
No push, no remote, no tags, no X post, no submit. Local commit only.

## Judge quickstart (do X → see Y), MEASURED pre-Celesto-only

```
cargo test --workspace     -> 31 passed (74.951s; rustc 1.100.0, near-sdk 5.30.2)
cargo build --target wasm32-unknown-unknown --release -> EXIT 0
cargo near build non-reproducible-wasm -> EXIT 0, deployable 331,467 B
tsc                        -> 0 errors / 0 warnings (EXIT 0 both)
npm test                   -> 26 tests / 26 pass / 0 fail, RC=0
offline suite              -> 24/24
env EIDOLON_DET_TICKS=112 npm test -> 2/2 determinism
golden digest assertion    -> EXIT 0
112-tick digest=30271fa8011c33c045f3577ada4bd9a9b722fd0a82bbd435f72c55222ef9b46f
storage 1,392,134 B; gas 29.96 Tgas/tick (gate) / 29.93 Tgas/tick (wasm-opt)
```

EXDEV reproduced on `/mnt/d` virtiofs (`Invalid cross-device link` RC=1);
ext4 RC=0. Raw-wasm +21.2% transient regression RESOLVED: cargo-near 406,811 B
→ 331,467 B deployable; wasm-opt `ozall` 327,771 B (−48.2%) with 36/18 ABI,
2/2 + gas gate green; original wasm restored. 24 variant rungs.

## Recordable demo outline (human records, human posts)

1. Show a villager wallet holding an NEP-245 inventory token and NEP-141 coin.
2. Advance one deterministic tick: production, spoilage, tax, market settlement,
   and the resulting balance change. One moment, visible result.
Q-012 video required when judges cannot open the demo. Tags @NEARProtocol,
#NEARHackathon. Main writes no post.

## Payload fields — ALL EMPTY, human supplies every value

| Field | Rule | Value |
|---|---|---|
| requestId | UUID, generated ONCE, reused on 400/503 | EMPTY |
| projectName | 2-80 chars | EMPTY |
| leadName | 2-80 chars | EMPTY |
| email | valid, <=160, max 2 submissions per address (Q-015) | EMPTY |
| size | `1` / `2 - 4` / `4 - 6` / `6 - 8` / `8+` | EMPTY |
| tracks | >=1 track id, each once; `games` fits | EMPTY |
| nearAddress | 2-64 lowercase mainnet account the team creates | EMPTY |
| projectUrl | http(s), <=300, public repo, unique | EMPTY |
| demoUrl | http(s), <=300, published X post | EMPTY |
| idea | 20-2000 chars | EMPTY |
| consent | `true` only after verbatim notice + human yes | EMPTY |

Never add `website`. Print full JSON, wait for explicit yes. 201 saved;
400 fix `fields` + same requestId; 403 stop; 409 stop; 413 shorten; 503 retry
same requestId.

## Rules checklist

- Q-003: 8 pre-existing tags, none of the required pair; no README diff link.
  **Not satisfied**; local tags deliberately not created.
- Q-012 video required when judges cannot open the demo.
- Q-014 `LICENSE` present. Q-017 README "Quickstart" at line 36 and
  "Dry-run demo" at line 68.
- Q-015 second project on same email must be named in README. Unresolved.
- Q-002/Q-005 disclosure: README "Attribution" line 143, "License" line 148.
- W8: dRPC N=2/3 HTTP 200, N=4 HTTP 400 code 31; core `-32700` UPHELD for
  that state only. No unbounded speedup claim.
- HELD: single-suite consolidation PROTOTYPED then REVERTED (cold wall 572.3
  vs 597.7 ms, no gain) per net-positive-ROI.

## Blockers (do not block submission)

Celesto `Trial credit is too low to start this sandbox` → clippy/fmt/
cargo-near-check BLOCKED-BY-CELESTO. Firecrawl daily credits BLOCKED (exact
credit line in `WAVE-3-eidolon.md` §7). Exa MCP 402 → direct REST. BoxLite §6
MEASURED `p6ieTxSadkD2`.

## Attestation

Nothing published, pushed, tagged, or submitted. No payload value invented.
