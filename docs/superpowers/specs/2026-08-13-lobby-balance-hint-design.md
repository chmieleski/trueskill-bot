# Lobby Balance Hint (OpenSkill) — Design

**Date:** 2026-08-13  
**Updated:** 2026-08-18 — always search; no 45–55% gate  
**Status:** Approved for implementation planning  
**Scope:** Advisory single-move (up to three) balance suggestion on Match Lobby whenever a strictly improving swap/move exists

## Goal

On the Match Lobby rating preview, show suggested moves that most improve fairness. The host applies them manually via existing Move/Swap controls. After each lobby sync, recompute; if a strictly better single move exists, show it (up to three).

This is **read-only advice**. Do not auto-apply roster changes. Do not use an LLM for this feature (may revisit later for copy only).

## Non-goals

- Auto-apply / Apply button
- Full reshuffle list or multi-move plans in one message
- LLM / Gemini narrative
- Balance hint on Match In Progress
- Calling OpenSkill `rate()` or updating ratings
- Classic Elo balancing formulas

## Domain rules

Reuse the same OpenSkill dual-entity model as lobby rating preview:

- Each human contributes **global** + **hero** (slot = hero id 1–12)
- Empty slots are absent entities
- Win chance via `predictWin` on dual-entity team arrays
- Destination hero for a hypothetical move uses that player’s `PlayerHeroRating` for the new `heroId` (cold-start μ `25` / σ `8.333` if missing)

Unbalanced human fills (e.g. 4v6) are valid. Suggestions **may** change team size by moving into an empty slot on the other team, as long as both teams keep ≥1 player.

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Algorithm | Greedy best **single** move (exhaustive candidates; up to 3 shown) |
| AI | None for now |
| Unbalanced gate | **None** — always search. Show if a strictly improving swap/move exists |
| UX | Always on Match Lobby embed when a suggestion exists |
| Apply | Advisory only — host uses Move/Swap |
| Team size | Allow moves into empty slots (size may change) |
| Surfaces | Match Lobby only |

## Algorithm

### Gate

Run suggestion search when:

1. Both teams have ≥1 human
2. Current `winChance` exists

There is **no** 45–55% band. A 52/48 lobby still gets hints if a swap/move gets closer to 50/50. A true 50/50 (or any roster with no strictly improving candidate) omits the field.

### Candidates

1. **Swap** — every pair of occupied slots on opposite teams  
2. **Move** — every occupied slot → every empty slot (1–12)

Skip any candidate that would leave Team A or Team B with zero humans.

### Score

For each candidate, build the post-move roster (update slots / hero ids), rebuild dual-entity teams with in-memory μ/σ (including destination hero ratings), call `predictWin`, round percents to sum 100 (same helper as preview).

**Current imbalance:** `|50 − teamAPercent|`  
**Candidate imbalance:** same on resulting percents  

Keep candidates that **strictly improve** (candidate imbalance < current imbalance).

### Pick

Among improving candidates, choose the smallest resulting imbalance. Ties:

1. Prefer `swap` over `move`
2. Then lower `fromSlot`
3. Then lower `toSlot`

If none improve, omit the hint.

## Architecture

```text
loadLobbyRatingPreview(roster)
  → ensure ratings (existing)
  → predictWin → winChance
  → suggestBalanceMoves(rosterSnapshot, ratingLookup)  // always, if both teams ≥1
      → enumerate swaps + empty-slot moves
      → score with predictWin (pure / in-memory)
      → return BalanceSuggestion[] (empty if none improve)
  → LobbyRatingPreview.balanceSuggestions?
  → buildMatchLobbyEmbed → optional Balance hint field
```

### Modules

| Module | Role |
|--------|------|
| `src/services/lobby-balance.ts` | Enumerate, score, pick; pure suggestion logic |
| `src/services/rating-preview.ts` | Call suggest after win chance; attach DTO field; batch any extra hero ratings needed for candidates |
| `src/services/lobby-preview.ts` | Format Balance hint field on Match Lobby only |
| `src/services/rating-math.ts` | Reuse `predictWin` wiring helpers / percent rounding |

Rating math stays out of commands and button handlers.

### Rating lookup for candidates

Preview load already upserts global + **current** hero ratings. Suggestion search also needs μ/σ for **destination** heroes (every empty slot and every opposite-team slot a player might take).

In the same preview pass:

1. Collect `(playerId, heroId)` pairs for all roster players × relevant destination hero ids (occupied opposite slots + empty slots), or equivalently all heroes 1–12 for roster players if simpler and still cheap
2. Ensure / fetch those `PlayerHeroRating` rows once
3. Pass an in-memory lookup into `suggestBalanceMove` so scoring is sync and DB-free

No N+1 queries inside the search loop.

## Data contracts

```ts
export interface BalanceSuggestion {
  kind: 'swap' | 'move';
  fromSlot: number;
  toSlot: number;
  fromNick: string;
  /** Present when kind === 'swap'. */
  toNick?: string;
  resultingWinChance: {
    teamAPercent: number;
    teamBPercent: number;
  };
}

export interface LobbyRatingPreview {
  players: LobbyRatingPlayerLine[];
  winChance?: {
    teamAPercent: number;
    teamBPercent: number;
  };
  balanceSuggestion?: BalanceSuggestion;
}
```

## Embed UI

### Match Lobby

When `balanceSuggestion` is set, add a field after the win-chance row:

- **Name:** `Balance hint`
- **Value:**
  - Swap: `Swap {fromNick} ({fromSlot}) ↔ {toNick} ({toSlot}) → ~{a}% / {b}%`
  - Move: `Move {fromNick} ({fromSlot}) → slot {toSlot} → ~{a}% / {b}%`

Percents are the **resulting** rounded win chances for Team A / Team B.

### Match In Progress

Do not show the Balance hint field (even if DTO carries it — prefer not computing it for in-progress sync).

## Edge cases

| Case | Behavior |
|------|----------|
| Win % 50/50 (or no improving move) | No hint |
| Unbalanced but no improving move | No hint |
| Move would empty a team | Skip candidate |
| Missing destination hero rating | Cold-start defaults in lookup |
| Search / `predictWin` failure | Log; omit hint; do not fail lobby sync |
| Percent rounding | Integers summing to 100 (shared helper) |

## Testing

Vitest unit tests for `lobby-balance` (and formatting if non-trivial):

- Gate: always search when both teams have ≥1 human; 50/50 with no improving move omits; 52/48 still eligible
- Improving swap/move selected; non-improving ignored
- Candidates that empty a team rejected
- Tie-break: swap over move; then lower `fromSlot`
- Resulting percents always sum to 100

No Discord integration tests.

## Spec self-review

- No TBD/TODO placeholders
- Algorithm matches “full re-deal intent, one move at a time” via iterative greedy steps after each host edit
- Advisory-only and lobby-only called out
- Destination hero cold-start and batch lookup prevent FK / N+1 issues
- Scope excludes AI, auto-apply, and in-progress embeds

## Out of scope (explicit)

- LLM phrasing
- Apply button / auto roster mutation
- Showing multiple alternative moves
- Balance hint after match start
- Global optimum full assignment search

## References

- ClickUp: [869ek4w9b](https://app.clickup.com/t/869ek4w9b) — *Always show lobby balance hint (no 45–55% gate)*
- Original feature: [869ek4pwr](https://app.clickup.com/t/869ek4pwr) — *Lobby Balance Hint (OpenSkill)*
