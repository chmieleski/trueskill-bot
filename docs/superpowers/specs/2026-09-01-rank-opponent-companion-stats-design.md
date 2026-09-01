# Rank Opponent Companion Stats — Design

**Date:** 2026-09-01  
**Status:** Approved for implementation planning  
**Scope:** `general` (league-scoped completed-match stats; same rules as teammate companion stats)  
**Related:** [`2026-08-22-player-companion-stats-design.md`](./2026-08-22-player-companion-stats-design.md)

## Goal

Anyone viewing a `/rank` profile can see that player’s **top 3 opponents** (opposite-team head-to-head), mirroring the existing teammate lists:

- **Played against** — most games faced
- **Win against** — best win rate vs opponents (≥5 games)
- **Lose against** — worst win rate vs opponents (≥5 games)

Each row uses the same monospace table format as teammates: `Nick  14G · 9W 5L · 64.3%`.

## Non-goals

- New slash commands, buttons, or custom IDs
- Discord mentions of opponents
- Denormalized pair tables or schema changes
- Env / SSM changes
- Configurable recency window, min-games floor, or list size
- Opponent stats on surfaces other than `/rank`
- Changing ki math, overall `/rank` W/L/Q, or existing teammate fields

## Locked decisions

| Topic               | Choice                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Approach            | On-read aggregates from existing `MatchPlayer` / `Match` query path. **One** Prisma load builds both teammate and opponent lists |
| Opponent definition | Every other `MatchPlayer` on the **opposite team** in an eligible match (including if the opponent quit)                         |
| Lists               | Three fields: Played against / Win against / Lose against                                                                        |
| Played against sort | `games` desc → `WR%` desc → nick A–Z. Max 3                                                                                      |
| Win against sort    | `WR%` desc → shared games desc → nick A–Z. Max 3. Min **5** shared games                                                         |
| Lose against sort   | `WR%` asc → shared games desc → nick A–Z. Max 3. Min **5** shared games                                                          |
| Recency             | Only opponents with a shared match in the **last 14 days** (`COMPANION_RECENCY_DAYS`)                                            |
| What counts         | `COMPLETED` matches where the **viewed player** has `WIN` or `LOSS`                                                              |
| Rank reset          | Same cutoff as `/rank` W/L and teammate lists (`isMatchCountedAfterRankReset`)                                                   |
| Quit (viewed)       | Match ignored for all opponent lists                                                                                             |
| Quit (opponent)     | Opponent still counts if the viewed player has WIN/LOSS                                                                          |
| Empty fields        | Omit a `/rank` field with 0 opponents. Show 1–2 if that is all                                                                   |
| Row copy            | Same columns as teammates: `Nick  14G · 9W 5L · 64.3%`                                                                           |
| Mentions            | Nicks only                                                                                                                       |
| Embed order         | After teammate fields: Played against → Win against → Lose against                                                               |
| Language            | English user-facing strings                                                                                                      |

## Approach

Extend the companion-stats module rather than duplicate it. The current `loadTeammateStats` already loads all completed WIN/LOSS rows for one `playerId` with full match rosters. Refactor to `loadCompanionStats` that, per eligible match row, collects:

- **Partners** — same team (`p.team === viewedTeam`)
- **Opponents** — opposite team (`p.team !== viewedTeam`)

Both pools feed the existing `aggregateCompanionPairs` → `pickTopTeammates` → `formatTeammateTable` pipeline. No second database query.

### Alternatives considered

| Option                                      | Verdict                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| Separate `loadOpponentStats` + second query | Rejected — doubles `/rank` DB work for no benefit                                |
| New `opponent-stats.ts` duplicating helpers | Rejected — violates DRY; helpers are already generic (`aggregateCompanionPairs`) |

## Formula

Reuse `winRatePercent(wins, losses)` from `rank-reset-display.ts`:

```text
games  = eligible matches where P and Q were on opposing teams
wins   = those where P.result === WIN
losses = those where P.result === LOSS
WR%    = winRatePercent(wins, losses)
```

`games === wins + losses` for every pair. Exclude P from their own lists.

Eligible match: `Match.status = COMPLETED`, `P.result ∈ {WIN, LOSS}`, same `leagueId`, after P’s latest rank reset.

## Architecture

```text
/rank execute
  → loadCompanionStats(leagueId, playerId)
      → matchPlayer.findMany (viewed player’s completed WIN/LOSS rows + full roster)
      → filter by rank-reset cutoff
      → per row: partners (same team) + opponents (opposite team)
      → aggregateCompanionPairs × 2
      → buildTeammateStatsFromPairs × 2  (teammates + opponents)
  → buildRankEmbed(profile, { teammates, opponents, … })
```

### Types

```typescript
type TeammateStats = {
  playedWith: TeammatePairStats[];
  winWith: TeammatePairStats[];
  loseWith: TeammatePairStats[];
};

/** Same shape as TeammateStats; field names differ only at embed layer. */
type OpponentStats = {
  playedAgainst: TeammatePairStats[];
  winAgainst: TeammatePairStats[];
  loseAgainst: TeammatePairStats[];
};

type CompanionStats = {
  teammates: TeammateStats;
  opponents: OpponentStats;
};
```

`buildOpponentStatsFromPairs` maps the shared `pickTopTeammates` output to `playedAgainst` / `winAgainst` / `loseAgainst` keys (same sort primaries: `games`, `winRate`, `loseRate`).

Keep `loadTeammateStats` as a thin deprecated wrapper or remove after call sites migrate — prefer a single `loadCompanionStats` export.

## Embeds

Gold accent `0xf0b232`. Existing `/rank` title, record, Heroes, teammate fields, thumbnail, and footer unchanged.

### `/rank` opponent fields

After teammate fields (Played with / Win with / Lose with). Field names: `Played against`, `Win against`, `Lose against`. Omit a field when its array is empty.

```text
Played against
RivalOne   12G · 8W 4L · 66.7%
RivalTwo   10G · 4W 6L · 40%
RivalThree  9G · 5W 4L · 55.6%
```

Reuse `formatTeammateTable` — identical column layout and padding.

A nick may appear on more than one list (e.g. most-played rival and worst matchup).

## Modules

| Path                                         | Responsibility                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/services/player/teammate-stats.ts`      | `aggregateOpponentPairs`, `buildOpponentStatsFromPairs`, `loadCompanionStats`; refactor loader |
| `src/services/player/teammate-stats.test.ts` | Opposite-team filter, aggregation, loader returns both pools                                   |
| `src/services/player/rank-embed.ts`          | 0–3 opponent fields after teammate fields                                                      |
| `src/services/player/rank-embed.test.ts`     | Field presence/order; teammate fields unchanged                                                |
| `src/services/player/index.ts`               | Export `loadCompanionStats`, `CompanionStats`, `OpponentStats`                                 |
| `src/commands/player/rank.ts`                | `loadCompanionStats`; pass `opponents` into embed                                              |
| `docs/discord/public/06-rank-and-boards.md`  | Extend line: top teammates **and opponents**                                                   |

Reuse `loadLatestRankResetAtByPlayer`, `isMatchCountedAfterRankReset`, `aggregateCompanionPairs`, `pickTopTeammates`, `formatTeammateTable`, `COMPANION_RECENCY_DAYS`, `WINRATE_LIST_MIN_GAMES`.

## Edge cases

| Case                                  | Result                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Solo on a team (no opponents)         | That match adds no opponents                                                |
| Opponent quit, viewed player WIN/LOSS | Opponent still counts                                                       |
| Viewed player quit                    | Match ignored                                                               |
| Rank reset                            | Opponent lists restart with teammate lists                                  |
| Partner on same list as opponent      | Impossible — same person cannot be same-team and opposite-team in one match |
| Four-way tie for 3rd                  | WR% then games then nick A–Z; still 3 rows                                  |
| Same nick on two lists                | Allowed                                                                     |
| Calibrating `/rank`                   | Opponent fields still show (same as hero WR / teammates)                    |
| Unlinked nick                         | Opponent nicks shown; no mentions                                           |
| 1–4 shared games                      | May appear on Played against only; excluded from Win/Lose against           |

No new user-facing error strings. `/rank` keeps today’s failure modes.

## Testing (acceptance)

Unit tests only (no Discord, no Prisma round-trip for helpers). Mock Prisma on the loader the same way existing teammate tests do.

- `aggregateOpponentPairs` — opposite-team only; excludes same-team partners; excludes self
- Rank-reset cutoff; viewed-player quit ignored; opponent quit included
- Recency window — idle pairs hidden from all lists
- `buildOpponentStatsFromPairs` — correct key mapping and sort primaries
- `loadCompanionStats` — single query; returns both teammate and opponent top-3 lists
- `buildRankEmbed` — omits empty opponent fields; order: teammates then opponents; existing fields unchanged
