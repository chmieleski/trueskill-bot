# Rank side W/L (Z / Evil) — Design

**Date:** 2026-08-26  
**Status:** Approved  
**Scope:** `general` (league flag + `MatchPlayer.team` aggregation; labels from game profile)

## Goal

On `/rank`, optionally show a player’s completed W–L split by side (team 1 vs team 2), so UDBR players can see Z Fighters vs Evil form without scanning the hero table.

## Product

When `League.showSideWinLoss` is on, append a second description line under the overall record:

```text
12W · 5L · 2Q · 0G · 70.6% WR
Z Fighters 8W · 3L · Evil 4W · 2L
```

- Labels from `GameProfile.teamNames` (UDBR: Z Fighters / Evil; ACA if enabled: Team A / Team B).
- Counts: completed `WIN`/`LOSS` only; same rank-reset cutoff as overall `/rank` W/L (quits stay in `Q`, not side L).
- Always show both sides when the flag is on (including `0W · 0L`).
- No per-side WR%.
- Flag off → no second line.

## Data & defaults

| Piece | Behavior |
| --- | --- |
| `League.showSideWinLoss` | Boolean, Prisma `@default(false)` |
| Migration backfill | `true` where `gameId = 'warcraft3_udbr'` |
| `GameProfile.sideWinLossDefault` | UDBR `true`, ACA `false` |
| `createLeague` | Seeds from `sideWinLossDefault` |
| Season rollover | Successor copies the flag |
| Staff | `/league_config set side_win_loss enabled:true\|false` |

## Architecture

```text
loadMatchDisplayStats → bySide (per player, team 1 / team 2)
loadPlayerProfile     → sideWinLoss when league flag on
buildRankEmbed        → second description line + teamNames
```

Aggregation keys off persisted `MatchPlayer.team` (1 | 2), not hero id buckets.

## Non-goals

- Leaderboard / match-list league-wide side WR (already exists)
- Hero-bucket aggregation
- Changing overall W/L or quit semantics
- Env / AWS SSM (DB column only)

## Test plan

1. Unit: side aggregation respects WIN/LOSS + rank-reset cutoff; ignores quits for W/L.
2. Unit: embed line present when `sideWinLoss` set; absent when null; uses profile team names.
3. Unit: UDBR/ACA `sideWinLossDefault`; config setter updates the column.
4. Manual: UDBR `/rank` shows Z/Evil line by default; ACA does not; toggle via `/league_config set side_win_loss`.
