# WOS Hero & Item Stats (`/hero`, `/items`) — Design

**Date:** 2026-08-29  
**Status:** Approved for implementation planning  
**Scope:** `general` (commands, aggregation, embeds) + `game:warcraft3_wos` (`ITEM_RATE` parsing, item catalog upsert)  
**Related:** [`2026-08-28-wos-match-file-report-design.md`](./2026-08-28-wos-match-file-report-design.md), [`2026-08-22-player-companion-stats-design.md`](./2026-08-22-player-companion-stats-design.md), [`2026-08-19-win-rate-display-design.md`](./2026-08-19-win-rate-display-design.md)

## Goal

WOS players can inspect **hero performance** and **item meta** from uploaded bot reports:

- **`/hero`** — league-wide averages for a hero (last 10 + overall), plus top players by WR; optional user/nick for that player’s stats on the hero.
- **`/items`** — top items by buy rate (last 10 + overall), with WR%; optional hero filter for build meta on one character.

Both commands are **WOS-only** (`postMatchStats === 'wos2_bot_v1'`). Data comes from persisted `MatchPlayerStats` rows; item names are built from `ITEM_RATE` lines in report files on upload.

## Non-goals (v1)

- UDBR or other games without WOS2 bot reports
- Assists (not in report format)
- Physical vs magic damage split in command output (use `damageTotal` / `takenTotal` only)
- Denormalized aggregate or cache tables
- Event / unrated match support (league-scoped only, same as `/rank`)
- Pagination or export
- Env / AWS SSM changes
- Showing item slots in match log embeds (out of scope; slots already persisted)
- Using in-game `ITEM_RATE` win/buy percentages directly (we compute our own from league data)

## Locked decisions

| Topic                   | Choice                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Approach                | On-read aggregates from `MatchPlayerStats` + small `GameItem` catalog. No rollup tables               |
| `/hero` shape           | Single command: required `hero`, optional `user` / `nick`, optional `window`                          |
| `/hero` default window  | `both` — show **Last 10** and **Overall** sections in one reply                                       |
| `/hero` league view     | Avg dmg / taken / heal / KDA + top **5** players by WR (min **3** games on hero in window)            |
| `/hero` player view     | Same stat block for one player; **no** top-players list                                               |
| Top players sort        | WR% desc → games desc → nick A–Z                                                                      |
| Rank reset              | Applies to **user** overall window only (same cutoff as `/rank`). League-wide hero stats ignore reset |
| `/items` scope          | Optional `hero` filter; omit = league-wide                                                            |
| `/items` default window | `both` — last 10 + overall                                                                            |
| `/items` rows           | Top **10** items per window by buy rate                                                               |
| `/items` columns        | Buy % + WR% + games with item (e.g. `Oken · 38% buy · 55% WR · 24G`)                                  |
| Item names              | Parse `ITEM_RATE` on report upload; upsert `GameItem` per `gameId` + `objectId`                       |
| Player ↔ item           | Use existing `itemSlot1`–`itemSlot6` on `MatchPlayerStats` (skip `0`)                                 |
| Hero autocomplete       | Distinct `heroName` from completed matches in resolved league (not UDBR `Hero` table)                 |
| Hero name match         | Case-insensitive trim (same normalization as WOS hero W/L on `/rank`)                                 |
| Game gate               | `profile.postMatchStats === 'wos2_bot_v1'`; friendly error in other leagues                           |
| KDA display             | `kills/deaths`; show `—` when deaths = 0                                                              |
| Averages                | Arithmetic mean per player-game row in window                                                         |
| Language                | English user-facing strings                                                                           |
| Mentions                | Nicks only (no Discord pings)                                                                         |

## User flows

### Flow A — `/hero hero:Raiden Ei`

1. User runs command in a WOS league channel (or with `league:` option).
2. Bot resolves league, verifies WOS profile.
3. Bot loads completed WIN/LOSS rows where `stats.heroName` matches (case-insensitive).
4. Bot replies with one embed:
   - **Last 10 games** — games count, avg dmg / taken / heal / KDA, top 5 players (if any qualify).
   - **Overall** — same fields for full league history on that hero.

### Flow B — `/hero hero:Frieren user:@Tiny`

1. Same gate and hero filter, plus player lookup (Discord user or `nick`, same as `/rank`).
2. Overall window respects that player’s latest rank reset.
3. Last 10 = their newest 10 games on that hero (post-reset).
4. Embed shows player nick in title; no top-players section.

### Flow C — `/items` / `/items hero:Frieren`

1. WOS gate + optional hero filter.
2. Per window: top 10 items by buy rate with WR% and game count.
3. Item display name from `GameItem`; fallback `Item #<objectId>`.

## Approach

**On-read aggregation** (recommended and chosen): query `MatchPlayerStats` joined to `MatchPlayer` and `Match` at command time. Matches companion-stats and WOS hero W/L patterns on `/rank`. One small schema addition (`GameItem`) for item name resolution.

Rejected alternatives:

- **Materialized rollups** — faster reads but invalidation complexity on corrections/resets; overkill for v1 league sizes.
- **Redis cache** — no existing infra; premature.

## Formula

Reuse `winRatePercent(wins, losses)` from `rank-reset-display.ts`:

```text
games = wins + losses
games === 0 → null
else → Math.round((wins / games) * 1000) / 10
```

### Eligible player-game row

```text
Match.status = COMPLETED
Match.leagueId = resolved league
MatchPlayer.result ∈ { WIN, LOSS }
stats.heroName present (non-empty after trim)
```

For **user** views, also apply `isMatchCountedAfterRankReset(match.completedAt, playerResetAt)` on overall (and last-10 is drawn from the post-reset eligible set).

### Last 10 window

```text
distinctMatchIds = eligible rows, order by match.completedAt DESC
last10MatchIds   = first 10 match IDs
windowRows       = eligible rows where matchId ∈ last10MatchIds
```

For league hero view, “last 10” means the 10 most recent **matches in the league** where anyone played that hero. For user hero view, the 10 most recent matches where **that player** played that hero.

### Hero averages (per window)

```text
games    = count(windowRows)
avgDmg   = mean(damageTotal)
avgTaken = mean(takenTotal)
avgHeal  = mean(heal)
kda      = sum(kills) / sum(deaths); display "—" when sum(deaths) === 0
```

Format KDA as one decimal ratio (e.g. `2.4`) or `kills/deaths` fraction — match existing match log style (`formatMatchStatsDetailedPlayerLine`).

### Top players on hero (league view only)

```text
bucket by playerId → wins, losses on windowRows
filter games >= 3
sort WR% desc → games desc → username asc
take 5
row: "{username} · {games}G · {wins}W {losses}L · {wr}%"
```

### Item buy rate (per window)

```text
denominator = count(eligible player-game rows in window)
              (if hero filter: rows where stats.heroName matches)

for each objectId in slots (itemSlot1..6, skip 0):
  gamesWithItem = rows where any slot === objectId
  buyRate       = gamesWithItem / denominator
  itemWins      = rows with item where result === WIN
  itemWR        = winRatePercent(itemWins, gamesWithItem - itemWins)
sort by buyRate desc → gamesWithItem desc → name asc
take 10
```

## Architecture

```text
/hero
  → resolveLeagueIdFromInteraction
  → getGameProfileForLeague (WOS gate)
  → loadHeroStats({ leagueId, heroName, playerId?, window })
  → buildHeroStatsEmbed(result)

/items
  → resolveLeagueIdFromInteraction
  → getGameProfileForLeague (WOS gate)
  → loadItemStats({ leagueId, heroName?, window })
  → buildItemStatsEmbed(result)

report upload (existing path)
  → parseWos2BotReport() (+ itemRates[])
  → persistWos2MatchStats()
  → upsertGameItems(gameId, itemRates)
```

```text
MatchPlayerStats + MatchPlayer + Match
  → hero aggregates, top players, item buy rates (on-read)

GameItem (gameId, objectId, name)
  → display names for /items
```

Commands stay thin; business logic in `src/services/player/`.

## Schema

### New model

```prisma
model GameItem {
  gameId    String
  objectId  Int
  name      String
  updatedAt DateTime @updatedAt

  game Game @relation(fields: [gameId], references: [id], onDelete: Cascade)

  @@id([gameId, objectId])
  @@index([gameId])
}
```

- Populated from `ITEM_RATE|item_id=…|item_name=…` on each report persist.
- Upsert: insert or update `name` when the same `objectId` appears with a new name.
- Scoped by `gameId` (not `leagueId`) — item object IDs are game-global.

No other schema changes. Player-item linkage remains on `MatchPlayerStats.itemSlot1`–`itemSlot6`.

## Modules

| Module                                              | Scope                | Responsibility                             |
| --------------------------------------------------- | -------------------- | ------------------------------------------ |
| `src/commands/player/hero.ts`                       | `general`            | Slash `data`, autocomplete, `execute`      |
| `src/commands/player/items.ts`                      | `general`            | Slash `data`, autocomplete, `execute`      |
| `src/services/player/hero-stats.ts`                 | `general`            | Load rows, aggregate windows, top players  |
| `src/services/player/item-stats.ts`                 | `general`            | Item buy rate + WR aggregates              |
| `src/services/player/hero-stats-embed.ts`           | `general`            | Discord embed                              |
| `src/services/player/item-stats-embed.ts`           | `general`            | Discord embed                              |
| `src/services/game/game-item-catalog.ts`            | `general`            | `upsertGameItems`, `resolveItemNames`      |
| `src/games/warcraft3_wos/wos2-bot-report-parser.ts` | `game:warcraft3_wos` | Parse `ITEM_RATE` lines into `itemRates[]` |
| `src/services/match/match-stats-upload.ts`          | `general`            | Call catalog upsert after persist          |

### Autocomplete

- **`hero` option (both commands):** query distinct `stats.heroName` from completed matches in resolved league; filter by focused string; max 25 choices.
- **`league` option:** existing `respondLeagueAutocomplete`.

## Slash command definitions

### `/hero`

```text
/hero
  hero: string (required, autocomplete)
  user: user (optional)
  nick: string (optional)
  window: choice [both | last10 | overall] (optional, default both)
  league: string (optional)
```

Mutually exclusive: `user` vs `nick` follows `/rank` lookup rules (`parseRankOptions` pattern).

### `/items`

```text
/items
  hero: string (optional, autocomplete)
  window: choice [both | last10 | overall] (optional, default both)
  league: string (optional)
```

## Embed layout

### `/hero` (league)

```text
Title: {heroName} — League stats
Fields:
  Last 10 games
    {games}G · Avg dmg {n} · Taken {n} · Heal {n} · KDA {ratio}
    Top players
    {player rows or "_Not enough data (need 3+ games per player)._"}
  Overall
    (same structure)
```

### `/hero` (player)

```text
Title: {username} on {heroName}
(same field structure, no Top players)
Footer (optional): Since rank reset {date} — only on overall when reset exists
```

### `/items`

```text
Title: Item stats — {league name} [on {heroName}]
Fields:
  Last 10 games
    {item rows}
  Overall
    {item rows}
```

Use `_italic_` Discord markdown for empty sections.

## Error handling

| Case                   | User message                                                             |
| ---------------------- | ------------------------------------------------------------------------ |
| Non-WOS league         | `Hero/item stats are only available for WOS leagues.`                    |
| Unknown hero (0 games) | `No completed matches found for **{hero}** in this league.`              |
| User not linked        | Same as `/rank` (`PlayerServiceError`)                                   |
| User never played hero | `**{nick}** has no recorded games on **{hero}**.`                        |
| No item data           | `_No item data yet — stats appear after matches with uploaded reports._` |
| League resolve failure | Existing league resolve messages                                         |

Defer reply if aggregation may exceed ~3s (same as `/rank` for non-self lookups).

## Testing

| Area       | Cases                                                                         |
| ---------- | ----------------------------------------------------------------------------- |
| Parser     | `ITEM_RATE` lines extracted; unknown line types still ignored                 |
| Catalog    | Upsert new item; update name on conflict                                      |
| Hero stats | Averages, last-10 match cutoff, top-5 + min-3 filter, rank-reset on user view |
| Hero stats | Case-insensitive hero match                                                   |
| Item stats | Buy rate denominator, WR per item, hero filter, empty slots ignored           |
| Commands   | WOS gate rejects UDBR league                                                  |
| Embeds     | Snapshot key fields / field count                                             |

## Migration & backfill

1. Run Prisma migration for `GameItem`.
2. **Optional backfill script** (not required for v1): re-parse `MatchStatsReport.rawText` for existing reports to seed `GameItem`. Commands work without backfill; items show `Item #id` until a report containing that item’s `ITEM_RATE` is processed (or backfill runs).

## Implementation notes

- Register commands in existing loader; run `deploy-commands` / dev auto-deploy.
- Export services from `src/services/player/index.ts` and `src/services/game/` as needed.
- Do not add game-specific imports to `league-resolve` or other `general` league modules.
- Format with Prettier before PR.
