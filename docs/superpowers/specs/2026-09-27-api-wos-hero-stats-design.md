# HTTP API — WOS hero & match combat stats — Design

**Date:** 2026-09-27  
**Status:** Approved for implementation planning  
**Scope:**

- `game:warcraft3_wos` — combat stats from `MatchPlayerStats`, hero/item catalogs, WOS profile gate
- `general` — HTTP routes on the existing bot API server, league Bearer auth reuse

**Related:** [`2026-09-07-api-wos-match-approval-design.md`](./2026-09-07-api-wos-match-approval-design.md), [`2026-08-29-wos-hero-item-stats-design.md`](./2026-08-29-wos-hero-item-stats-design.md), [`docs/api/wos-match-upload.md`](../../api/wos-match-upload.md)

## Goal

Let the same external app that uploads WOS match reports **read** league hero combat stats and per-match player stats over HTTP. Payloads are **richer than Discord** (`/hero` embeds stay totals-only): phys/magic splits, item slots with resolved names, and aggregate avg **and** sum fields. Eligibility rules stay aligned with Discord hero-stats loaders.

## Non-goals (v1)

- Public / unauthenticated access
- Player-centric routes (`/v1/players/...`)
- UDBR or non-WOS leagues
- Event / unrated matches
- Changing Discord embed fields or slash command output
- Materialized rollup tables or Redis cache
- New env / AWS SSM keys
- HTTPS / Cloudflare (tracked separately)

## Decisions (locked)

| Topic             | Choice                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Approach          | Extend shared hero-stats loaders + thin HTTP routes (Approach 1)                                            |
| Consumer          | Same upload app; reuse league API Bearer token                                                              |
| Lookups           | Hero catalog + hero aggregates; match detail by `matchId`                                                   |
| Field richness    | Full `MatchPlayerStats` combat + items; aggregates include avg **and** sum for all combat fields            |
| Windows           | Exclusive scopes: `all` \| `last` \| `range` \| `both` (default `both`)                                     |
| Last-N            | `games` query param (default `20`, clamp 1–100) when scope is `last` or `both`                              |
| Time range        | `scope=range` requires `from` (ISO-8601 inclusive); optional `to` (exclusive, default now) on `completedAt` |
| Stacking filters  | Do **not** apply `from`/`to` on top of `all`/`last` — use `range` for time-bounded stats                    |
| Hero key          | Path segment: URL-encoded name **or** numeric `objectId` string; same resolver family as `/hero`            |
| Rank reset        | League-wide hero aggregates ignore reset (same as Discord `/hero` league view)                              |
| Top players       | Min 3 games in window; default limit 5; clamp 0–25 (`0` omits list)                                         |
| Wrong HTTP method | Same as upload route: known path + wrong method → `404 Not Found`                                           |
| Process           | Same Node HTTP API (`API_ENABLED`) as match upload                                                          |

## Endpoints

Auth on all: `Authorization: Bearer <league_api_token>` → resolve league. Non-WOS league (`postMatchStats !== 'wos2_bot_v1'`) → `403`.

| Method | Path                         | Purpose                                           |
| ------ | ---------------------------- | ------------------------------------------------- |
| `GET`  | `/v1/heroes`                 | Heroes seen in this league (name + `objectId`)    |
| `GET`  | `/v1/heroes/:heroKey/stats`  | Aggregates (+ optional recent games) for one hero |
| `GET`  | `/v1/matches/:matchId/stats` | Full per-player combat stats for one match        |

### `GET /v1/heroes`

**Success — `200`**

```json
{
  "leagueId": "…",
  "heroes": [{ "objectId": 123, "name": "Raiden Ei" }]
}
```

Source: distinct heroes from completed league `MatchPlayerStats` / `GameHero` catalog (same identity sources as Discord hero autocomplete). Sort by name A–Z.

### `GET /v1/heroes/:heroKey/stats`

**Query parameters**

| Param         | Default | Notes                                                               |
| ------------- | ------- | ------------------------------------------------------------------- |
| `scope`       | `both`  | `all` \| `last` \| `range` \| `both`                                |
| `games`       | `20`    | Last-N size when `scope` is `last` or `both`; clamp 1–100           |
| `from`        | —       | Required when `scope=range`; ISO-8601; filter `match.completedAt` ≥ |
| `to`          | now     | Optional when `scope=range`; ISO-8601; filter `match.completedAt` < |
| `recentLimit` | `20`    | Recent games list length; clamp 1–50                                |
| `topPlayers`  | `5`     | Top-players list size; clamp 0–25; `0` omits                        |

**Window keys in response** (only keys for the requested scope):

| `scope` | `windows` keys |
| ------- | -------------- |
| `all`   | `all`          |
| `last`  | `last`         |
| `range` | `range`        |
| `both`  | `all`, `last`  |

`recentGames` uses the same row pool as the active scope; for `both`, use the `last` pool (capped by `recentLimit`).

**Success — `200`**

```json
{
  "leagueId": "…",
  "hero": { "objectId": 123, "name": "Raiden Ei" },
  "windows": {
    "all": {},
    "last": {}
  },
  "recentGames": []
}
```

`hero.objectId` may be `null` when the hero is name-only (no catalog/object id).

#### `HeroWindowAggregate`

| Field                                               | Type           | Notes                                                                          |
| --------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `games`, `wins`, `losses`                           | number         | WIN/LOSS counts                                                                |
| `winRatePercent`                                    | number \| null | Same `winRatePercent` helper as Discord; `null` when `games === 0`             |
| `avgDamageTotal`, `avgDamagePhys`, `avgDamageMagic` | number         | Rounded arithmetic means over player-game rows                                 |
| `avgTakenTotal`, `avgTakenPhys`, `avgTakenMagic`    | number         |                                                                                |
| `avgHeal`, `avgKills`, `avgDeaths`                  | number         |                                                                                |
| `sumDamageTotal`, `sumDamagePhys`, `sumDamageMagic` | number         |                                                                                |
| `sumTakenTotal`, `sumTakenPhys`, `sumTakenMagic`    | number         |                                                                                |
| `sumHeal`, `sumKills`, `sumDeaths`                  | number         |                                                                                |
| `kda`                                               | string         | `kills/deaths` ratio string or `—` when deaths = 0 (same formatter as Discord) |
| `topPlayers`                                        | array          | Omitted or empty when `topPlayers=0`; else ranked list                         |

#### `TopPlayer` entry

`username`, `games`, `wins`, `losses`, `winRatePercent`, `avgDamageTotal`, `avgDamagePhys`, `avgDamageMagic`, `avgTakenTotal`, `avgHeal`, `kda`.  
Default sort: win rate desc → games desc → username A–Z. Min **3** games in window (same as Discord).

#### `RecentGame` / player combat row

| Field                                      | Notes                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `matchId`, `playerId`, `username`          |                                                                                     |
| `result`                                   | `WIN` \| `LOSS`                                                                     |
| `completedAt`                              | ISO-8601 or `null`                                                                  |
| `kills`, `deaths`                          |                                                                                     |
| `damagePhys`, `damageMagic`, `damageTotal` |                                                                                     |
| `takenPhys`, `takenMagic`, `takenTotal`    |                                                                                     |
| `heal`                                     |                                                                                     |
| `heroObjectId`, `heroName`                 | May be null                                                                         |
| `items`                                    | `{ objectId, name }` for slots 1–6 where slot ≠ 0; `name` from `GameItem` or `null` |

### `GET /v1/matches/:matchId/stats`

**Success — `200`**

```json
{
  "matchId": "…",
  "leagueId": "…",
  "status": "COMPLETED",
  "externalId": "…",
  "completedAt": "…",
  "players": [
    {
      "playerId": "…",
      "username": "…",
      "team": 1,
      "slot": 1,
      "result": "WIN",
      "kills": 0,
      "deaths": 0,
      "damagePhys": 0,
      "damageMagic": 0,
      "damageTotal": 0,
      "takenPhys": 0,
      "takenMagic": 0,
      "takenTotal": 0,
      "heal": 0,
      "heroObjectId": 123,
      "heroName": "…",
      "items": [{ "objectId": 1, "name": "Oken" }]
    }
  ]
}
```

- `404` if match missing or `match.leagueId` ≠ token league.
- Include players that have a `MatchPlayerStats` row even when status is not yet `COMPLETED` (e.g. approval queue). Players without stats are omitted from `players` (or listed with combat fields absent — **prefer omit** for a stable contract).
- `externalId` from `MatchStatsReport` when present, else `null`.

## Eligibility (shared with Discord)

```text
Match.leagueId = token league
Match.status = COMPLETED          // hero aggregate / catalog queries
MatchPlayer.result ∈ { WIN, LOSS }
stats.heroName is not null        // for hero identity filtering
```

Match detail endpoint does **not** require `COMPLETED` (see above).

Hero selection: resolve `:heroKey` as numeric `objectId` when the segment is all digits; otherwise treat as hero name via `resolveHeroSelection` (catalog → league report names → name-only).

## Architecture

```text
Bearer token
  → resolveLeagueFromApiToken
  → WOS gate (game profile)
  → route handler
       → loaders (extended hero-stats + new match-stats)
       → JSON DTO
```

1. **Shared auth helper** — extract Bearer → league resolution used by wos-report and the new GET routes (avoid copy-paste).
2. **Loader extension** — broaden Prisma selects in hero-stats (or a dedicated `api` adapter that reuses selection/window helpers) to include phys/magic/items; add aggregate avg+sum; add `last N` and `completedAt` range filters; support objectId path keys.
3. **Item names** — `resolveItemNames(gameId, objectIds)` / existing game-item catalog helpers.
4. **Discord unchanged** — embed builders keep using totals-only aggregates.
5. **Router** — register new handlers in `handleApiRequest` next to wos-report.

## Errors

| Code  | When                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| `401` | Missing / invalid Bearer token                                                                                        |
| `403` | League is not WOS (`postMatchStats !== 'wos2_bot_v1'`)                                                                |
| `400` | Invalid `scope`, `games`, `recentLimit`, `topPlayers`; `scope=range` without `from`; invalid ISO dates; `from` ≥ `to` |
| `404` | Unknown path; wrong method on known path; unknown hero; match not in league                                           |
| `500` | Unhandled server error                                                                                                |

## Docs

- New integrator guide: `docs/api/wos-hero-stats.md` (auth, endpoints, examples).
- Cross-link from `docs/api/wos-match-upload.md`.

## Testing

- Unit tests: window parsing/validation; aggregate avg/sum; last-N and range filters; hero key (name vs objectId).
- Route tests: auth 401, WOS 403, validation 400, hero/match happy paths, match wrong-league 404.
- No Discord embed regressions required beyond existing tests (embeds not changed).

## Out of scope follow-ups

- Player-centric stats API
- Sortable hero-all board over HTTP
- Item meta endpoint (`/items` equivalent)
- Pagination beyond `recentLimit` / `topPlayers` clamps
