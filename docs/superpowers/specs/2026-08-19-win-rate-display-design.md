# Win Rate Display (profile heroes + leaderboards) — Design

**Date:** 2026-08-19  
**Status:** Approved for implementation planning  
**Scope:** `general` (per-league completed-match stats; not game-specific)

## Goal

Players can see **character win rate** on `/rank` hero rows, and a **WR column** on the existing overall and single-hero leaderboards (including the live overall message). Ranking stays by **ki**. Overall `/rank` W/L + WR is unchanged.

## Non-goals (v1)

- A WR-ranked leaderboard (no new `/leaderboard` type)
- WR on the all-heroes compact board (`/leaderboard show type:hero` with no hero)
- Denormalized `wins` / `losses` columns on `PlayerRating` or `PlayerHeroRating`
- Per-hero quit counts
- Changing what `G` means (overall = completed W+L; hero boards = `PlayerHeroRating.matchesPlayed`)
- Configurable minimum-games threshold for showing WR
- Schema, env, or SSM changes
- New slash commands or button custom IDs

## Locked decisions

| Topic | Choice |
|-------|--------|
| `/rank` overall line | Unchanged (`12W · 5L · 2Q · 70.6% WR`) |
| `/rank` hero row | `Goku  4200 · 5W 3L · 62.5%` — no raw game count |
| Overall + live overall | Keep `G`, add `WR` — `# Player Ki G WR` |
| Single-hero board | Same table as overall (`G` stays `matchesPlayed`) |
| All-heroes compact | Ki only — no WR |
| Sort | Still ki desc (not WR) |
| Formula | `wins / (wins + losses)`; one decimal; omit `%` when 0 games |
| What counts | Completed WIN/LOSS after that player’s latest rank reset — same as overall W/L |
| Quitters | Not in W/L; overall `Q` stays on the profile record only |
| No hero on the match | Skip that row for character WR (`heroId` null, ACA / `optional_in_game`) |
| Computation | **On-read aggregate** from `MatchPlayer` |
| Language | English user-facing strings |

## Approach

Extend the existing rank-reset display-stats path. Overall WR is already computed for `/rank` from per-player W/L; overall/live boards already load those buckets and only need to pass WR through. Character WR is the same rows grouped by `(playerId, heroId)`.

## Formula

```text
winRatePercent(wins, losses): number | null
  games = wins + losses
  games === 0 → null
  else → Math.round((wins / games) * 1000) / 10
```

Examples: `5/8` → `62.5`; `1/1` → `100`; `2/3` → `66.7`; `0/1` → `0`; `0/0` → `null`.

Extract this from the inline `/rank` overall calculation so profile, hero rows, and leaderboards share one function.

## Data flow

```text
MatchPlayer (COMPLETED WIN/LOSS + quitter rows, rank-reset cutoff)
  ├─ by playerId        → overall WR (profile record + overall/live boards)
  └─ by playerId+heroId → character WR (profile heroes + single-hero board)
                          skip heroId == null; no per-hero Q

PlayerHeroRating.matchesPlayed → still G / hero-ki games on hero boards
```

`loadMatchDisplayStatsByPlayer` already loads every completed WIN/LOSS (and quitter) row in the league and applies the cutoff. Add `heroId` to that select.

- Keep `loadMatchDisplayStatsByPlayer`’s return type unchanged (overall buckets ignore `heroId`).
- Add `aggregateHeroMatchDisplayStats` → nested `Map<playerId, Map<heroId, { wins, losses }>>`.
- Add a **bundle loader** used when both maps are needed (`loadPlayerProfile`, `loadHeroLeaderboard`) so the league is queried once.
- Overall/live boards keep calling the existing by-player loader; they already have `wins` / `losses`.

### Who consumes what

| Surface | Data | Change |
|---------|------|--------|
| `/rank` overall | existing `PlayerProfile.winRatePercent` | use shared `winRatePercent()` |
| `/rank` Heroes | `PlayerProfileHero` += `wins`, `losses`, `winRatePercent` | join this player’s hero buckets onto `PlayerHeroRating` rows (`matchesPlayed > 0`) |
| Overall + live | `OverallLeaderboardEntry` += `winRatePercent` | from existing per-player stats |
| Single-hero | `HeroLeaderboardEntry` += `winRatePercent` | from `(playerId, heroId)` buckets |
| All-heroes compact | `HeroLeaderboardEntry.winRatePercent` always set | **`formatHeroCompactTable` does not render it** |

### Known mismatch (leave it)

After a **continue-rollover**, hero `G` can be copied `matchesPlayed` while WR is **current-league** W/L only. Same pattern as overall ki vs overall W/L. Do not hide WR or invent a second G.

## DTOs

```typescript
function winRatePercent(wins: number, losses: number): number | null

type PlayerHeroMatchDisplayStats = {
  wins: number;
  losses: number;
}

type PlayerProfileHero = {
  heroId: number;
  name: string;
  ki: number;
  matchesPlayed: number; // still from PlayerHeroRating; not shown in the table
  wins: number;
  losses: number;
  winRatePercent: number | null;
}

type OverallLeaderboardEntry = {
  // …existing fields…
  winRatePercent: number | null;
}

type HeroLeaderboardEntry = {
  // …existing fields…
  winRatePercent: number | null;
}
```

Overall eligible rows already require `games >= 1`, so overall/live WR is never `null` in practice. Single-hero WR may be `null` when `matchesPlayed > 0` but counted W+L is 0 (continue-rollover).

Missing hero bucket → `{ wins: 0, losses: 0, winRatePercent: null }`.

## Embeds

Gold accent `0xf0b232`. Monospace tables. Medals and competition rank unchanged.

### `/rank` Heroes

Only when `showHeroes` is true and there is at least one hero row.

```text
Goku    4200 · 5W 3L · 62.5%
Vegeta  3900 · 2W 2L · 50%
Krillin Calibrating · 0W 1L · 0%
```

- Align name and ki like today; then `NW NL`; then `· {wr}%` when `winRatePercent !== null`.
- Stringify like the overall record: `` `${winRatePercent}%` `` — do not force a trailing `.0` (`50` → `50%`, `62.5` → `62.5%`, `0` → `0%`).
- 0 counted games on that hero: `0W 0L` with no `%`.
- Calibrating **league** games (`< 5` overall W+L) still hide the ki number and print `Calibrating` (existing `formatPublicKi(hero.ki, leagueGames)`). WR still shows.

### Overall, live overall, single-hero

```text
#   Player   Ki    G  WR
🥇  Tinys    4200  17  70.6%
🥈  Ghost    4100  12    50%
—   Rookie   Calibrating  2    50%
```

- Header `WR` (not `Win%`).
- Same stringify as `/rank` (`` `${n}%` ``). Right-align to the longest cell on that page (typical max `62.5%`).
- `winRatePercent === null` → `—` (keeps the column aligned; overall/live rows with `games >= 1` should not hit this).
- Empty copy unchanged: `_No ranked players yet._` / `_No games yet for {hero}._`.
- Live chunk size stays **25**. Do not split columns across fields.

Single-hero reuses `formatOverallTable` (today it maps `matchesPlayed` → `games`). Add `winRatePercent` to that mapped entry.

### All-heroes compact

Unchanged: `# name ki` via `formatHeroCompactTable`. No `G`, no `WR`.

## Modules

Slash adapters stay thin. No command option or customId changes. Live refresh keeps calling the same embed builder.

| Path | Responsibility |
|------|----------------|
| `src/services/rating/rank-reset-display.ts` | `winRatePercent()`, select `heroId`, `aggregateHeroMatchDisplayStats`, bundle loader |
| `src/services/rating/rank-reset-display.test.ts` | Formula + hero aggregation |
| `src/services/player/player-profile.ts` | Join hero W/L onto `PlayerProfileHero` |
| `src/services/player/rank-embed.ts` | Hero table `NW NL · WR%` |
| `src/services/player/rank-embed.test.ts` | Hero table snapshots |
| `src/services/leaderboard/leaderboard.ts` | Plumb `winRatePercent` on overall + single-hero entries |
| `src/services/leaderboard/leaderboard-embed.ts` | `WR` column on `formatOverallTable` |
| `src/services/leaderboard/leaderboard-embed.test.ts` | Overall/single-hero WR; compact unchanged |
| `src/services/leaderboard/leaderboard.test.ts` | Mapping / pagination still works with the extra field |

## Edge cases

| Case | Result |
|------|--------|
| 0 completed WIN/LOSS | Omit `%` on profile; leaderboard `WR` is `—` |
| Rank reset | Same cutoff as overall W/L — pre-reset games do not count |
| Quitter | Not a W or L; overall `Q` unchanged; no per-hero Q |
| `heroId` null / ACA | No character WR; Heroes field stays hidden when `showHeroes` is false / no hero rows |
| Hero `matchesPlayed > 0` but 0 counted W/L | Profile: `0W 0L` omit `%`; single-hero: `G` = matchesPlayed, `WR` = `—` |
| Calibrating (`< 5` league games) | WR still shown; ki still `Calibrating` |
| Compact all-heroes | No WR, no new errors |
| Unknown hero / empty boards | Existing copy only |

No new user-facing error strings. Pagination, live refresh, and `/leaderboard` adapters stay as they are.

## Testing

Unit tests only (no Discord, no Prisma round-trip required for the new helpers).

- `winRatePercent` — 0 games → `null`; `5/8` → `62.5`; `1/1` → `100`; `2/3` → `66.7`
- `aggregateHeroMatchDisplayStats` — rank-reset cutoff; skip null `heroId`; quitters ignored; two heroes for one player stay separate
- `formatHeroTable` — `5W 3L · 62.5%`; omit `%` when null; calibrating ki unchanged
- `formatOverallTable` — `WR` header + values; `—` when null; compact table still has no WR
- Leaderboard DTOs — overall entry WR from existing W/L; single-hero from `(playerId, heroId)`

## Out of scope follow-ups

- Dedicated winrate ladder (sort by WR, min games)
- WR on compact all-heroes
- Denormalize W/L if league match history gets large enough that on-read aggregation is slow
- Per-hero Q on `/rank`
