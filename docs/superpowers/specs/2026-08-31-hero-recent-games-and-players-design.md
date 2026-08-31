# Hero Recent Games & `/hero_players` — Design

**Date:** 2026-08-31  
**Status:** Approved for implementation planning  
**Scope:** `general` (extends existing `/hero`; new `/hero_players` command)  
**Related:** [`2026-08-29-wos-hero-item-stats-design.md`](./2026-08-29-wos-hero-item-stats-design.md)

## Goal

Extend WOS hero stats with:

1. **`/hero`** — add a **Recent games** section (player + league views) and an optional `recent` count (5 or 10, default 5).
2. **`/hero_players`** — new command for a deeper, sortable top-players list (limit 5 / 10 / 25, default 10).

`/hero` stays the quick overview (averages + top 5 by WR). `/hero_players` is the dedicated leaderboard.

## Non-goals (v1)

- Pagination buttons on `/hero_players` (25-row cap is enough for v1)
- Player-scoped `/hero_players` (`user` / `nick`)
- Changes to `/leaderboard hero` (UDBR ki ratings — different system)
- UDBR or non-WOS leagues
- Denormalized aggregate / cache tables
- Event / unrated matches
- Env / AWS SSM changes
- Discord mentions (nicks only)

## Locked decisions

| Topic                  | Choice                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Recent games scope     | **Both views** — player recent games in player view; league recent games in league view |
| Recent games count     | Optional `recent` on `/hero`: **5** (default) or **10**                                 |
| Recent games placement | Single **Recent games** field below stat windows (not duplicated per window)            |
| Player recent games    | That player's last N games on the hero; **respects rank reset**                         |
| League recent games    | Last N player-game rows league-wide on the hero; **ignores rank reset**                 |
| Top players depth      | New **`/hero_players`** command (not more options on `/hero`)                           |
| `/hero_players` sorts  | `win_rate` (default), `games`, `damage`, `kda`                                          |
| `/hero_players` limit  | Choice **5 / 10 / 25**, default **10**                                                  |
| `/hero_players` window | Same as `/hero`: `both` (default), `last10`, `overall`                                  |
| Min games (rankings)   | **3** games on hero in window (unchanged)                                               |
| `win_rate` tie-break   | WR% desc → games desc → nick A–Z                                                        |
| `games` tie-break      | games desc → WR% desc → nick A–Z                                                        |
| `damage` tie-break     | avg dmg desc → games desc → nick A–Z                                                    |
| `kda` tie-break        | KDA desc → games desc → nick A–Z                                                        |
| KDA formula            | `sum(kills) / sum(deaths)` per player in window; `—` when deaths = 0                    |
| Data approach          | On-read from `MatchPlayerStats` (same as existing `/hero`)                              |
| Game gate              | `profile.postMatchStats === 'wos2_bot_v1'`                                              |
| Language               | English user-facing strings                                                             |

## User flows

### Flow A — `/hero hero:Raiden Ei recent:10`

1. User runs command in a WOS league channel (or with `league:`).
2. Bot resolves league, verifies WOS profile.
3. Bot replies with existing **Last 10** + **Overall** stat windows and top 5 by WR.
4. Bot adds **Recent games** — last 10 league matches where anyone played Raiden Ei (nick, result, date, copyable `matchId`).

### Flow B — `/hero hero:Frieren user:@Tiny recent:5`

1. Same gate + player lookup as today.
2. Player stats respect rank reset.
3. Bot adds **Recent games** — Tiny's last 5 games on Frieren (outcome, date, copyable `matchId`; match-history style).

### Flow C — `/hero_players hero:Goku sort:damage limit:25 window:last10`

1. WOS gate + hero resolve.
2. Bot replies with one embed field for **Last 10 games** listing up to 25 players sorted by avg damage (min 3 games).
3. No **Overall** field when `window:last10`.

## Approach

**Shared loaders in `hero-stats.ts`** (recommended):

- `pickRecentHeroGames(rows, limit)` — pure helper for recent-game rows.
- `rankHeroPlayers(rows, sort, limit)` — pure helper for sortable rankings (extends today's top-players bucket logic).
- `loadHeroStats` extended to return `recentGames: HeroRecentGame[]`.
- `loadHeroPlayerRankings` — new loader for `/hero_players`.

Rejected alternative: one monolithic loader returning everything for both commands — heavier queries when only one command runs.

## Data model

### Eligible row (unchanged)

```text
Match.status = COMPLETED
Match.leagueId = resolved league
MatchPlayer.result ∈ { WIN, LOSS }
stats.heroName matches hero (case-insensitive)
```

Player views also apply `isMatchCountedAfterRankReset` on the row set.

### Recent games

```text
sortedRows = eligible rows, order by match.completedAt DESC, then matchId DESC
recentRows = sortedRows.slice(0, recentLimit)
```

Player view: rows already filtered to one `playerId`.  
League view: all eligible rows (one entry per player per match).

### Player rankings (`/hero_players`)

Bucket eligible rows per `playerId` in the window, compute per player:

```text
games, wins, losses, winRatePercent
avgDamage = mean(damageTotal)
kda       = sum(kills) / sum(deaths)  (— display when sum(deaths) = 0)
```

Filter `games >= 3`, sort per locked tie-break rules, `slice(0, limit)`.

## Slash command definitions

### `/hero` (extended)

```text
/hero
  hero:   string (required, autocomplete)
  user:   user (optional)
  nick:   string (optional)
  window: choice [both | last10 | overall] (optional, default both)
  recent: choice [5 | 10] (optional, default 5)    ← NEW
  league: string (optional)
```

### `/hero_players` (new)

```text
/hero_players
  hero:   string (required, autocomplete)
  sort:   choice [win_rate | games | damage | kda] (optional, default win_rate)
  limit:  choice [5 | 10 | 25] (optional, default 10)
  window: choice [both | last10 | overall] (optional, default both)
  league: string (optional)
```

Hero autocomplete: reuse `listWosHeroNamesForLeague` (same as `/hero`).

## Embed layout

### `/hero` — league view (addition)

```text
…existing Last 10 / Overall fields…

Recent games
Tiny · Win · Jan 15, 2026
`clxxxxxxxxxxxxxxxxxxxxxxx`
Bob · Loss · Jan 14, 2026
`clxxxxxxxxxxxxxxxxxxxxxxx`
…
```

### `/hero` — player view (addition)

```text
…existing fields…

Recent games
✅ Win · Jan 15, 2026
`clxxxxxxxxxxxxxxxxxxxxxxx`
❌ Loss · Jan 14, 2026
`clxxxxxxxxxxxxxxxxxxxxxxx`
…
```

Omit **Recent games** when there are zero eligible rows (should not happen if stats loaded, but guard anyway).

### `/hero_players`

```text
Title: {heroName} — Top players by {sort label}
Description: {league name}

Last 10 games
1. Tiny · 8G · 6W 2L · 75% · avg 42k dmg · KDA 3.2
2. …

Overall
(same when window = both)
```

Sort labels: `Win rate`, `Games played`, `Avg damage`, `KDA`.

Empty window: `_Not enough data (need 3+ games per player)._`

## File map

| File                                             | Scope     | Responsibility                                                                                 |
| ------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------- |
| `src/services/player/hero-stats.ts`              | `general` | `pickRecentHeroGames`, `rankHeroPlayers`, extend `loadHeroStats`, add `loadHeroPlayerRankings` |
| `src/services/player/hero-stats.test.ts`         | `general` | Unit tests for recent games + ranking sorts                                                    |
| `src/services/player/hero-stats-embed.ts`        | `general` | Recent games field on `/hero` embed                                                            |
| `src/services/player/hero-stats-embed.test.ts`   | `general` | Embed snapshots for recent games                                                               |
| `src/services/player/hero-players-embed.ts`      | `general` | `buildHeroPlayersEmbed`                                                                        |
| `src/services/player/hero-players-embed.test.ts` | `general` | Embed snapshots                                                                                |
| `src/commands/player/hero.ts`                    | `general` | Add `recent` option                                                                            |
| `src/commands/player/hero-players.ts`            | `general` | New slash command                                                                              |
| `src/services/player/index.ts`                   | `general` | Re-export new public APIs                                                                      |
| `CHANGELOG.md`                                   | —         | Unreleased entry                                                                               |

Commands auto-load via `src/handlers/load-commands.ts`.

## Testing

- Pure functions: recent-game picking, each sort mode, tie-breakers, min-games filter.
- Embed builders: field names/values for league + player recent games; `/hero_players` ranked rows.
- Manual: `/hero` league + player views with `recent:5` and `recent:10`; `/hero_players` each sort + limit in a WOS dev league.

## Success criteria

- `/hero` shows recent games in both league and player views; `recent` defaults to 5.
- `/hero_players` returns up to 25 ranked players per window with four sort modes.
- `/hero` top-5-by-WR overview unchanged.
- WOS gate and rank-reset behavior preserved.
- `npm run typecheck` and relevant Vitest suites pass; `npm run format:check` clean before PR.
