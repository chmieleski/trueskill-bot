# `/hero_all` & `/items` Sort — Design

**Date:** 2026-09-01  
**Status:** Approved for implementation planning  
**Scope:** `general` (WOS stats commands; `game:warcraft3_wos` gate only)  
**Related:** [`2026-08-29-wos-hero-item-stats-design.md`](./2026-08-29-wos-hero-item-stats-design.md), [`2026-08-31-hero-recent-games-and-players-design.md`](./2026-08-31-hero-recent-games-and-players-design.md)

## Goal

1. **`/hero_all`** — league-wide ranking of **all heroes** that have been played, sortable by combat/meta stats, with **last 20 games** and/or **overall** windows and slash `page` pagination.
2. **`/items` sort** — optional `sort` on existing `/items` to order the top-10 list by **buy rate** (default), **win rate**, or **pick count**.

`/hero_all` is the inverse of `/hero_players`: rank heroes instead of players on one hero.

## Non-goals (v1)

- Button pagination on `/hero_all` (slash `page` only)
- Changing `/hero`, `/hero_players`, or `/items` from **last 10** to last 20
- Min-games threshold on heroes (≥1 player-game row in the window qualifies)
- Player-scoped `/hero_all`
- Showing heroes with zero games in the league
- Denormalized aggregates / cache tables
- Event / unrated matches
- Env / AWS SSM changes
- Discord mentions (display names only)

## Locked decisions

| Topic                     | Choice                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Hero pool                 | Heroes with **≥1 completed player-game row** in the league (same pool as WOS hero autocomplete) |
| `/hero_all` windows       | `both` (default), `last20`, `overall` — **last 20 distinct matches** league-wide (not last 10)  |
| `/hero_all` default sort  | **Win rate** desc                                                                               |
| `/hero_all` sorts         | `win_rate`, `games`, `damage`, `taken`, `heal`                                                  |
| `/hero_all` pagination    | **15 heroes per page**; optional `page` integer (default 1), clamped                            |
| `/hero_all` table columns | Hero · WR · G · Dmg · Taken · Heal (monospace table per window field)                           |
| `/hero_all` rank reset    | **Ignored** (league-wide, same as `/hero` league view)                                          |
| `/items` sort default     | **Buy rate** (unchanged behavior)                                                               |
| `/items` sort choices     | `buy_rate`, `win_rate`, `picks`                                                                 |
| `/items` row cap          | Still top **10** items per window after sort                                                    |
| Data approach             | On-read from `MatchPlayerStats` (same as existing WOS stats)                                    |
| Game gate                 | `profile.postMatchStats === 'wos2_bot_v1'`                                                      |
| Language                  | English user-facing strings                                                                     |

### Tie-breaks (`/hero_all`)

| Sort       | Primary        | Secondary  | Tertiary      |
| ---------- | -------------- | ---------- | ------------- |
| `win_rate` | WR% desc       | games desc | hero name A–Z |
| `games`    | games desc     | WR% desc   | hero name A–Z |
| `damage`   | avg dmg desc   | games desc | hero name A–Z |
| `taken`    | avg taken desc | games desc | hero name A–Z |
| `heal`     | avg heal desc  | games desc | hero name A–Z |

### Tie-breaks (`/items` sort)

| Sort       | Primary              | Secondary  | Tertiary      |
| ---------- | -------------------- | ---------- | ------------- |
| `buy_rate` | buy % desc           | picks desc | item name A–Z |
| `win_rate` | WR% desc (null last) | picks desc | item name A–Z |
| `picks`    | picks desc           | buy % desc | item name A–Z |

WR% and averages reuse `winRatePercent` and arithmetic means per player-game row (same as `/hero`).

## User flows

### Flow A — `/hero_all sort:games window:both page:2`

1. User runs command in a WOS league channel (or with `league:`).
2. Bot resolves league, verifies WOS profile.
3. Bot loads all completed WIN/LOSS rows with hero stats for the league.
4. Bot aggregates per hero for **Last 20 games** and **Overall**, sorts by games played, slices page 2 (heroes 16–30).
5. Embed: title `All heroes — sorted by Games played`, two fields when `window:both`.

### Flow B — `/hero_all window:last20`

1. Same gate and aggregation.
2. Single embed field **Last 20 games** only.

### Flow C — `/items hero:Frieren sort:win_rate`

1. WOS gate + optional hero filter.
2. Per window: top 10 items sorted by WR% (not buy rate).
3. Table columns unchanged: Item · Buy · WR · Picks.

## Approach

**On-read aggregation in `hero-stats.ts`** (recommended):

- One league-wide query; bucket rows by hero (`normalizeHeroNameKey` + display name).
- `filterRowsToLastNMatches(rows, 20)` for the last-20 window (refactor existing last-10 helper to call this with `N=10` for unchanged commands).
- `rankAllHeroes(buckets, sort)` pure sort; `loadAllHeroRankings` loader + pagination.
- New `hero-all-embed.ts` + `hero-all.ts` command mirroring `/hero_players` structure.

**`/items`:** add `ItemSort` and pass `sort` into `aggregateItemWindowStats` before `.slice(0, 10)`.

Rejected: per-page DB queries (cannot sort globally without full scan), materialized rollups (overkill).

## Architecture

```
/hero_all (command)
  → loadAllHeroRankings({ leagueId, sort, windows, page })
      → prisma: all completed rows with stats.heroName
      → group by hero → aggregate per window
      → rankAllHeroes → paginate
  → buildHeroAllEmbed(result)

/items (command) — extend
  → loadItemStats({ …, sort })
      → aggregateItemWindowStats(rows, names, sort)
```

### New / modified modules

| Module                                  | Scope     | Responsibility                                                                                                                |
| --------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/services/player/hero-stats.ts`     | `general` | `filterRowsToLastNMatches`, `HeroAllSort`, `HeroAllEntry`, `rankAllHeroes`, `loadAllHeroRankings`, `parseHeroAllStatsWindows` |
| `src/services/player/hero-all-embed.ts` | `general` | `buildHeroAllEmbed`                                                                                                           |
| `src/commands/player/hero-all.ts`       | `general` | Slash `data`, `execute`                                                                                                       |
| `src/services/player/item-stats.ts`     | `general` | `ItemSort`, sort param on `aggregateItemWindowStats`                                                                          |
| `src/commands/player/items.ts`          | `general` | `sort` option                                                                                                                 |

## Command shapes

### `/hero_all`

```
/hero_all
  sort:   win_rate (default) | games | damage | taken | heal
  window: both (default) | last20 | overall
  page:   integer ≥ 1 (default 1)
  league: optional
```

### `/items` (addition)

```
/items
  …existing hero, window…
  sort: buy_rate (default) | win_rate | picks
```

## Embed examples

### `/hero_all` (window:both, sort:win_rate, page 1)

```
Title: All heroes — sorted by Win rate
Description: <league name>
Page 1 of 3 · 42 heroes

Field: Last 20 games
┌ Hero ───────────── WR    G  Dmg  Taken Heal
│ Raiden Ei        62.5%  24  18k   9k   2k
│ …

Field: Overall
(same table shape, overall aggregates)
```

Empty league: `_No hero data yet — stats appear after matches with uploaded reports._`

### `/items sort:win_rate`

Same table as today; rows ordered by WR column instead of Buy.

## Error handling

| Case                   | Response                                              |
| ---------------------- | ----------------------------------------------------- |
| Non-WOS league         | `Hero/item stats are only available for WOS leagues.` |
| No rows in league      | No-data message (same tone as `/items`)               |
| `page` > totalPages    | Clamp to last page (same as `/hero_matches`)          |
| League resolve failure | Existing `resolveLeagueIdFromInteraction` message     |

## Testing

- Unit: `filterRowsToLastNMatches` (N=20), `rankAllHeroes` tie-breaks, pagination slice
- Unit: `aggregateItemWindowStats` with each `ItemSort`
- Embed snapshots: `hero-all-embed.test.ts`, extend `item-stats-embed.test.ts` if needed
- Manual: `/hero_all` and `/items sort:win_rate` in dev guild

## Changelog

Unreleased entry under WOS stats: `/hero_all` command; `/items` sort option.
