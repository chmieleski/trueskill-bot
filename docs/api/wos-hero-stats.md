# WOS hero & match combat stats API — integrator guide

For app developers who read **Warcraft III WOS** hero aggregates and per-match combat stats from the same league API used for match upload.

**Base URL (production):** `http://63.186.224.240:8787`  
**Protocol:** HTTP JSON (HTTPS + Cloudflare planned later — see issue #163)

**Related:** [WOS match upload API](./wos-match-upload.md) (same Bearer token and league)

---

## What this API does

1. **List heroes** seen in completed league matches (catalog + report names).
2. **Hero aggregates** — win/loss, avg/sum combat splits (phys/magic), optional top players and recent games.
3. **Match detail** — full per-player combat stats and resolved item names for one match.

Payloads are **richer than Discord** `/hero` embeds (totals-only in Discord). League-wide aggregates **ignore rank reset** (same as Discord league hero view). Eligibility for aggregates matches Discord hero-stats loaders (completed matches, WIN/LOSS, non-null hero name).

Your app does **not** need a separate token. Reuse the league API token from `/league_config` → **api_token** → `rotate` (see upload guide).

---

## Auth

All endpoints:

|              |                                            |
| ------------ | ------------------------------------------ |
| Method       | **`GET` only** (POST → `404 Not Found`)    |
| Auth         | `Authorization: Bearer <league_api_token>` |

```http
Authorization: Bearer YOUR_LEAGUE_API_TOKEN
```

The token selects the league. Non-WOS leagues (`postMatchStats !== wos2_bot_v1`) receive **`403 Forbidden`**.

---

## Endpoints

| Method | Path                         | Purpose                                    |
| ------ | ---------------------------- | ------------------------------------------ |
| `GET`  | `/v1/heroes`                 | Heroes in this league (name + `objectId`)  |
| `GET`  | `/v1/heroes/:heroKey/stats`  | Aggregates (+ optional lists) for one hero |
| `GET`  | `/v1/matches/:matchId/stats` | Per-player combat stats for one match      |

### Hero key (`:heroKey`)

Path segment after URL encoding:

- **Numeric string** (all digits) → hero `objectId` in the game catalog.
- **Otherwise** → hero name (same resolution as Discord `/hero`: catalog → league report names → name-only).

Use `encodeURIComponent` for names with spaces or special characters. Malformed percent-encoding → **`400`** with `{ "error": "Invalid hero key encoding." }`.

---

### `GET /v1/heroes`

**Success — `200`**

```json
{
  "leagueId": "clxxxxxxxx",
  "heroes": [{ "objectId": 123, "name": "Raiden Ei" }]
}
```

Heroes are sorted by name A–Z. `objectId` may be omitted or null for name-only heroes depending on catalog data.

---

### `GET /v1/heroes/:heroKey/stats`

**Query parameters**

| Param         | Default | Notes                                                                 |
| ------------- | ------- | --------------------------------------------------------------------- |
| `scope`       | `both`  | `all` \| `last` \| `range` \| `both`                                  |
| `games`       | `20`    | Last-N size when `scope` is `last` or `both`; integer **1–100**       |
| `from`        | —       | **Required** when `scope=range`; ISO-8601; `match.completedAt` ≥     |
| `to`          | now     | Optional when `scope=range`; ISO-8601; `match.completedAt` **<**    |
| `recentLimit` | `20`    | Recent games list length; integer **1–50**                            |
| `topPlayers`  | `5`     | Top players list size; integer **0–25**; **`0` omits** the list     |

**Scope behavior**

| `scope` | `windows` keys in response | Notes                                                          |
| ------- | -------------------------- | -------------------------------------------------------------- |
| `all`   | `all`                      | All completed eligible games                                   |
| `last`  | `last`                     | Last `games` completed games                                   |
| `range` | `range`                    | Time window on `completedAt`; do not pass `from`/`to` otherwise |
| `both`  | `all`, `last`              | Default; `recentGames` uses the **last** pool                  |

Do **not** pass `from` or `to` unless `scope=range`.

**Success — `200`** (shape abbreviated)

```json
{
  "leagueId": "clxxxxxxxx",
  "hero": { "objectId": 123, "name": "Raiden Ei" },
  "windows": {
    "all": {
      "games": 10,
      "wins": 6,
      "losses": 4,
      "winRatePercent": 60,
      "avgDamageTotal": 500,
      "avgDamagePhys": 200,
      "avgDamageMagic": 300,
      "avgTakenTotal": 100,
      "avgTakenPhys": 40,
      "avgTakenMagic": 60,
      "avgHeal": 10,
      "avgKills": 2,
      "avgDeaths": 1,
      "sumDamageTotal": 5000,
      "sumDamagePhys": 2000,
      "sumDamageMagic": 3000,
      "sumTakenTotal": 1000,
      "sumTakenPhys": 400,
      "sumTakenMagic": 600,
      "sumHeal": 100,
      "sumKills": 20,
      "sumDeaths": 10,
      "kda": "2",
      "topPlayers": []
    }
  },
  "recentGames": []
}
```

- `winRatePercent` is `null` when `games === 0`.
- `kda` is a ratio string or `—` when deaths = 0 (Discord formatter).
- **Top players:** minimum **3** games in the window; default sort win rate desc → games desc → username A–Z.
- **Recent games:** each row includes combat fields, `result`, `completedAt`, hero identity, and `items` as `{ objectId, name }` per slot (name from catalog or `null`).

Unknown hero → **`404 Not Found`**.

---

### `GET /v1/matches/:matchId/stats`

No query parameters.

**Success — `200`**

```json
{
  "matchId": "clxxxxxxxx",
  "leagueId": "clxxxxxxxx",
  "status": "COMPLETED",
  "externalId": "34508754-98989487-41346570-71702689",
  "completedAt": "2026-01-10T12:00:00.000Z",
  "players": [
    {
      "playerId": "clxxxxxxxx",
      "username": "Nick#1234",
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
      "heroName": "Raiden Ei",
      "items": [{ "objectId": 1, "name": "Oken" }]
    }
  ]
}
```

- **`404`** if the match does not exist or belongs to another league.
- Includes players with a `MatchPlayerStats` row even when status is not yet `COMPLETED` (e.g. approval queue). Players **without** a stats row are omitted.
- `externalId` from the WOS report when present, else `null`.

Use `matchId` from upload **`201`** responses or from your stored records.

---

## Errors

All error bodies:

```json
{ "error": "English message" }
```

| HTTP  | When                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `401` | Missing/invalid Bearer token                                                                                                         |
| `403` | League is not WOS                                                                                                                    |
| `400` | Invalid query params; `scope=range` without `from`; invalid ISO dates; `from` ≥ `to`; **`from`/`to` with non-`range` scope**; bad hero key encoding |
| `404` | Unknown path; **non-GET** on these paths; unknown hero; match not in league                                                        |
| `500` | Unexpected server error                                                                                                              |

Example validation messages: `Invalid scope: must be one of all, last, range, both`, `from is required when scope is range`, `Invalid hero key encoding.`

---

## Examples (`curl`)

```bash
BASE_URL="http://63.186.224.240:8787"
TOKEN="paste_token_from_league_config_rotate"
```

**List heroes**

```bash
curl -sS "$BASE_URL/v1/heroes" \
  -H "Authorization: Bearer $TOKEN"
```

**Hero stats (name key, default scope `both`)**

```bash
HERO='Raiden Ei'
curl -sS "$BASE_URL/v1/heroes/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$HERO")/stats" \
  -H "Authorization: Bearer $TOKEN"
```

**Hero stats by object id, last 50 games, no top players**

```bash
curl -sS "$BASE_URL/v1/heroes/123/stats?scope=last&games=50&topPlayers=0" \
  -H "Authorization: Bearer $TOKEN"
```

**Hero stats for a date range**

```bash
curl -sS "$BASE_URL/v1/heroes/123/stats?scope=range&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z" \
  -H "Authorization: Bearer $TOKEN"
```

**Match combat stats**

```bash
MATCH_ID="clxxxxxxxx"
curl -sS "$BASE_URL/v1/matches/$MATCH_ID/stats" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Client checklist

1. Reuse the same league token as match upload (secret storage).
2. Prefer numeric `objectId` from `GET /v1/heroes` when stable; otherwise URL-encode hero names.
3. Use `scope=range` for calendar windows; do not add `from`/`to` to `all` or `last`.
4. After upload `201`, poll or link `GET /v1/matches/:matchId/stats` once the match has stats rows (including while `WAITING_FOR_APPROVAL`).
5. Never put the token in the query string.

---

## Out of scope (v1)

- Player-centric routes (`/v1/players/...`)
- UDBR / non-WOS leagues
- Unauthenticated access
- Discord embed parity (HTTP is strictly richer)

---

## Support

- Bot / league config: Discord server staff
- API contract / bugs: repo `chmieleski/trueskill-bot`
- Design spec: [`docs/superpowers/specs/2026-09-27-api-wos-hero-stats-design.md`](../superpowers/specs/2026-09-27-api-wos-hero-stats-design.md)
- Match upload: [`docs/api/wos-match-upload.md`](./wos-match-upload.md)
- Future HTTPS domain: GitHub issue [#163](https://github.com/chmieleski/trueskill-bot/issues/163)
