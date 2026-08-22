# Independent overall vs hero OpenSkill `rate()` — Design

**Date:** 2026-08-22  
**Status:** Approved  
**Scope:** `general` (OpenSkill apply shell; keyed by `leagueId`)  
**Related:** [`2026-08-22-player-hero-balance-weight-design.md`](./2026-08-22-player-hero-balance-weight-design.md) (predictWin 80/20; this spec **supersedes** dual-entity `rate()`), [`2026-08-18-lobby-relative-rating-scale-design.md`](./2026-08-18-lobby-relative-rating-scale-design.md), [`2026-08-22-new-player-rating-isolation-design.md`](./2026-08-22-new-player-rating-isolation-design.md), `.cursor/rules/openskill-rating.mdc`

## Goal

Overall ki should not be taxed by the hero you picked. A win on a cold or off-hero must move **league-global** μ the same as a win on a main, given the same overall ratings and the same opponents.

Today one `rate()` treats `[overall, hero]` as two equal teammates. The hero entity (especially high-σ) absorbs most of the Δμ and also changes team expected strength, so overall gains get pulled back. Lobby win% already treats hero as 20% of a seat; apply still treats it as 50%.

## Non-goals

- Merging `PlayerRating` and `PlayerHeroRating` into one μ
- Changing the 80/20 `predictWin` / balance-hint blend
- Changing public display-ki formula, soft-z, or the two roster ki numbers
- Changing New-player isolation, calibrating label, or lobby-relative scale **rules** (still applied; see below)
- Retroactive rewrite of persisted ladder μ/σ
- OpenSkill package weights / a blended-then-split `rate()`

## Locked decisions

| Topic | Choice |
| ----- | ------ |
| Approach | Two independent `rate()` calls: overall-only, then hero-only |
| Overall team | One entity per `activeRateable` human: `[μ_player]` |
| Hero team | One entity per `activeRateable` human with `heroId` set: `[μ_hero]` |
| Same outcome | Both calls use the same win/loss ranks |
| Empty overall side | Unchanged: if either team has 0 `activeRateable` humans → skip **both** team `rate()` calls (no throw) |
| Empty hero side | If either team has 0 hero seats → skip **hero** `rate()` only; overall still runs |
| ACA (`heroId` null) | Overall only; no hero seat |
| New / quitters | Unchanged partition; excluded from **both** team `rate()` calls. New non-quit still freeze |
| Quit / griffer synthetics | Two N=1 peer losses: overall vs mirrored overall, hero vs mirrored hero (when `heroId` set) |
| Lobby-relative scale | After both `rate()` calls; same global-ki offset on overall **and** hero Δμ; σ unchanged |
| Quit synthetics vs scale | Still **not** lobby-scaled |
| Hero `matchesPlayed` | Increment on non-quit apply with `heroId`; still **not** on quit |
| History / `/match flip` | Replay / re-apply **current** math from snapshots. No ladder backfill |
| Language | English user-facing strings (none new for v1) |

## Product note (intentional)

Overall will move **more even on a main**. Dual-entity `rate()` split credit with a second teammate and mixed high-σ hero noise into team variance. After this, a 6v6 overall update is 6 vs 6 humans, not 12 vs 12 entities. Off-pick no longer taxes overall; mains also stop donating half the swing to the hero row.

Hero remains a parallel ladder: a cold hero still takes a large high-σ swing on **hero** ki.

## Apply flow

Quit/griffer synthetics stay in `applyQuitterPenalties` / `applyGrifferPenalties` (and the matching loops inside `simulatePostMatchRatings`). Team `rate()` stays in `applyMatchRatings` / `simulatePostMatchRatings`. Both paths use the same overall-only and hero-only entity builders.

```text
synthetics (per flagged human):
  N=1 overall vs mirrored overall
  if heroId: N=1 hero vs mirrored hero

team rate (activeRateable only):
  if !canRunTeamRate: skip both team rate() (no throw)
  snapshot pre-match μ/σ
  rate overall: [globals on winners] vs [globals on losers]
  if canRunHeroRate: rate hero: [heroes on winners] vs [heroes on losers]
  lobby-relative scale Δμ (global-ki offset) on updated overall and hero
  persist / write maps
```

`canRunHeroRate` is the hero-seat analogue of `canRunTeamRate`: both teams have ≥1 `activeRateable` entry with `heroId != null`. Mixed UDBR + ACA is valid (5 hero seats vs 6). All-ACA vs UDBR → skip hero `rate()`.

Match-report, correction, and history keep calling those functions. No command or embed call-site changes.

## Architecture

```text
ratingEntitiesForBalance     → predictWin / lobby-balance (80/20, unchanged)
overall team builder         → rate() + overall synthetics  ([global] per human)
hero team builder            → rate() + hero synthetics     ([hero] when heroId set)
```

| Call site | Helper |
| --------- | ------ |
| `rating-update.ts` overall `rate()` + overall synthetics | overall-only entities |
| `rating-update.ts` hero `rate()` + hero synthetics | hero-only entities |
| `rating-preview.ts` `computeWinChanceFromRatings` | `ratingEntitiesForBalance` (unchanged) |
| `lobby-balance.ts` `winChanceForRoster` | `ratingEntitiesForBalance` (unchanged) |

`ratingEntitiesForPlayer` today returns `[global, hero]`. Replace apply/synthetic uses with the two builders above. Do not feed dual-entity arrays into `rate()`.

No Prisma migration. Tables stay separate (SRP).

## Edge cases

| Case | Rule |
| ---- | ---- |
| Off-hero / cold hero | Overall `rate()` never sees hero μ/σ. Same overall + same opponents → same overall Δμ regardless of pick |
| ACA | Overall only |
| Mixed UDBR + ACA | Hero pass uses only `heroId` seats; skip hero `rate()` if either team has 0 |
| New / quitters | Excluded from both team `rate()` calls |
| Quit / griffer | Independent synthetics on each ladder; hero `matchesPlayed` not incremented on quit |
| Empty rateable team | Skip both team `rate()` calls; synthetics still run |
| Lobby-relative scale | Same global-ki offset on both ladders; σ untouched |
| `/match flip` (24h) | Restore snapshots, re-apply current math (will not reproduce dual-entity results) |
| History embeds | `simulatePostMatchRatings` from snapshots uses current math; **display** deltas on old matches can change; persisted ladder is not backfilled |
| Leaderboard | Formula unchanged; going-forward overall ki moves more per game |

## Testing (acceptance)

- **Product claim:** two 1v1s with identical overall μ/σ and the same outcome, one cold hero vs one main hero → **overall Δμ is equal**; hero Δμ is not
- ACA: `PlayerHeroRating` is not read or written
- New freeze still holds; veterans still rate
- Skip both team `rate()` when a side has no `activeRateable` humans
- Skip hero `rate()` when a side has no hero seats; overall still updates
- Quit synthetics move both ladders (hero only when `heroId` set)
- `applyMatchRatings` and `simulatePostMatchRatings` stay in lockstep
- Lobby-relative scale still applies the global-ki offset to both Δμs
- Existing “high-rated loser loses more ki” direction holds; **magnitudes will change** — retune numbers, keep the inequality

## Docs to update at implementation

- `.cursor/rules/openskill-rating.mdc` — `rate()` is two independent ladders, not dual-entity; keep 80/20 as predictWin-only
- `2026-08-22-player-hero-balance-weight-design.md` — note that apply/synthetics are no longer dual-entity (this spec)

## Open follow-ups (not v1)

- Align lobby win% with overall-only `rate()` (drop 80/20) if product later wants odds = apply expected
- Backfill / one-time ladder replay
- Different lobby-relative scale for the hero ladder
