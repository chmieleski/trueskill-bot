# WOS hero & match combat stats API — integrator guide

For external app developers who need to **read** Warcraft III **WOS** hero combat aggregates and per-match player stats from Punch Machine / the Discord ranking bot.

**Status:** Implemented on branch `feat/api-wos-hero-stats` (not yet merged). Production will expose these routes after merge + deploy. Until then, use this document as the **contract** for integration.

|                           |                                                            |
| ------------------------- | ---------------------------------------------------------- |
| **Base URL (production)** | `http://63.186.224.240:8787`                               |
| **Protocol**              | HTTP JSON (HTTPS + Cloudflare planned later)               |
| **Auth**                  | Same league Bearer token as match upload                   |
| **Related upload API**    | `docs/api/wos-match-upload.md` (same token, same base URL) |

---

## Prerequisites (ops / staff)

Someone with Discord **Manage Guild** must configure the target WOS league:

1. `/league_config` → set **match approval channel** (needed for uploads; not required just to call GET stats if a token already exists).
2. `/league_config` → **api_token** → `rotate`  
   Copy the plaintext token **once** (it is not shown again). Store it as a secret in your app.

- One token = one league.
- Do not share tokens across leagues or commit them to git.
- Do not put the token in the URL or query string.

---

## What this API does

| Capability                                                             | Endpoint                         |
| ---------------------------------------------------------------------- | -------------------------------- |
| List heroes seen in the league                                         | `GET /v1/heroes`                 |
| Hero aggregates (WR, avg/sum damage splits, top players, recent games) | `GET /v1/heroes/:heroKey/stats`  |
| Full combat stats for one match                                        | `GET /v1/matches/:matchId/stats` |

Payloads are **richer than Discord** `/hero` embeds (Discord shows totals only). League-wide hero aggregates **ignore player rank reset** (same as Discord’s league-wide `/hero` view).

Your app does **not** complete rankings or moderate matches. Reading stats is independent of upload approval.

---

## Auth (all endpoints)

```http
GET /v1/... HTTP/1.1
Authorization: Bearer YOUR_LEAGUE_API_TOKEN
```

| Rule                  | Detail                                                         |
| --------------------- | -------------------------------------------------------------- |
| Method                | **`GET` only**. Other methods on these paths → `404 Not Found` |
| Token                 | Resolves to exactly one league                                 |
| Non-WOS league        | `403 Forbidden` (`{ "error": "Forbidden" }`)                   |
| Missing/invalid token | `401 Unauthorized`                                             |

---

## Endpoints overview

| Method | Path                         | Purpose                                     |
| ------ | ---------------------------- | ------------------------------------------- |
| `GET`  | `/v1/heroes`                 | Heroes in this league (`name` + `objectId`) |
| `GET`  | `/v1/heroes/:heroKey/stats`  | Aggregates (+ optional lists) for one hero  |
| `GET`  | `/v1/matches/:matchId/stats` | Per-player combat stats for one match       |

---

## Hero key (`:heroKey`)

Path segment (URL-encode names):

| Form                           | Meaning                                                   |
| ------------------------------ | --------------------------------------------------------- |
| All digits (e.g. `123`)        | Hero **objectId**                                         |
| Otherwise (e.g. `Raiden%20Ei`) | Hero **name** (catalog → league report names → name-only) |

Malformed percent-encoding → **`400`** `{ "error": "Invalid hero key encoding." }`.

Prefer `objectId` from `GET /v1/heroes` when available — more stable than display names.

---

## `GET /v1/heroes`

Lists distinct heroes from **completed** matches in the token’s league. Sorted by name A–Z.

### Success — `200`

```json
{
  "leagueId": "clxxxxxxxx",
  "heroes": [
    { "objectId": 123, "name": "Raiden Ei" },
    { "objectId": null, "name": "Legacy Name Only" }
  ]
}
```

| Field               | Type           | Notes                                                    |
| ------------------- | -------------- | -------------------------------------------------------- |
| `leagueId`          | string         | Always the token’s league                                |
| `heroes[].objectId` | number \| null | Always present; `null` when name-only (no WC3 object id) |
| `heroes[].name`     | string         | Display name                                             |

---

## `GET /v1/heroes/:heroKey/stats`

### Query parameters

| Param         | Default | Allowed                              | Notes                                                                 |
| ------------- | ------- | ------------------------------------ | --------------------------------------------------------------------- |
| `scope`       | `both`  | `all` \| `last` \| `range` \| `both` | Which windows to compute                                              |
| `games`       | `20`    | integer **1–100**                    | Used when `scope` is `last` or `both`                                 |
| `from`        | —       | ISO-8601                             | **Required** if `scope=range`; inclusive lower bound on `completedAt` |
| `to`          | now     | ISO-8601                             | Optional if `scope=range`; **exclusive** upper bound                  |
| `recentLimit` | `20`    | integer **1–50**                     | Length of `recentGames`                                               |
| `topPlayers`  | `5`     | integer **0–25**                     | `0` → empty `topPlayers` array                                        |

**Do not** send `from` or `to` unless `scope=range` (server returns `400`).

### Scope → response `windows` keys

| `scope` | Keys in `windows` | Notes                                         |
| ------- | ----------------- | --------------------------------------------- |
| `all`   | `all`             | Full league history for that hero             |
| `last`  | `last`            | Last `games` distinct matches                 |
| `range` | `range`           | Rows with `completedAt` in `[from, to)`       |
| `both`  | `all`, `last`     | Default; `recentGames` uses the **last** pool |

### Eligibility (aggregates)

- Match `status` = `COMPLETED`
- Player result `WIN` or `LOSS`
- Stats row has a hero identity
- Scoped to the token’s `leagueId`

Unknown hero / zero eligible games → **`404 Not Found`**.

### Success — `200`

```json
{
  "leagueId": "clxxxxxxxx",
  "hero": { "objectId": 123, "name": "Raiden Ei" },
  "windows": {
    "all": { "...": "HeroWindowAggregate" },
    "last": { "...": "HeroWindowAggregate" }
  },
  "recentGames": [
    {
      "matchId": "clxxxxxxxx",
      "playerId": "clxxxxxxxx",
      "username": "Nick#1234",
      "result": "WIN",
      "completedAt": "2026-01-10T12:00:00.000Z",
      "kills": 2,
      "deaths": 1,
      "damagePhys": 1000,
      "damageMagic": 2000,
      "damageTotal": 3000,
      "takenPhys": 400,
      "takenMagic": 600,
      "takenTotal": 1000,
      "heal": 50,
      "heroObjectId": 123,
      "heroName": "Raiden Ei",
      "items": [
        { "objectId": 1, "name": "Oken" },
        { "objectId": 2, "name": null }
      ]
    }
  ]
}
```

#### `HeroWindowAggregate` fields

| Field                                               | Type           | Notes                                                                                 |
| --------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `games`, `wins`, `losses`                           | number         |                                                                                       |
| `winRatePercent`                                    | number \| null | `null` when `games === 0`; otherwise one decimal place style (same helper as Discord) |
| `avgDamageTotal`, `avgDamagePhys`, `avgDamageMagic` | number         | Rounded means                                                                         |
| `avgTakenTotal`, `avgTakenPhys`, `avgTakenMagic`    | number         |                                                                                       |
| `avgHeal`, `avgKills`, `avgDeaths`                  | number         |                                                                                       |
| `sumDamageTotal`, `sumDamagePhys`, `sumDamageMagic` | number         |                                                                                       |
| `sumTakenTotal`, `sumTakenPhys`, `sumTakenMagic`    | number         |                                                                                       |
| `sumHeal`, `sumKills`, `sumDeaths`                  | number         |                                                                                       |
| `kda`                                               | string         | Ratio string, or `—` when deaths = 0                                                  |
| `topPlayers`                                        | array          | See below                                                                             |

#### `topPlayers[]` entry

| Field                                               | Type   |
| --------------------------------------------------- | ------ |
| `username`                                          | string |
| `games`, `wins`, `losses`                           | number |
| `winRatePercent`                                    | number |
| `avgDamageTotal`, `avgDamagePhys`, `avgDamageMagic` | number |
| `avgTakenTotal`, `avgHeal`                          | number |
| `kda`                                               | string |

Rules: minimum **3** games in that window; sort win rate desc → games desc → username A–Z; capped by `topPlayers`.

#### `recentGames[]` / combat row fields

Same combat field set as match detail (kills/deaths, phys/magic/total damage & taken, heal, hero identity, `items`). Dates are ISO-8601 strings or `null`.

---

## `GET /v1/matches/:matchId/stats`

No query parameters. Use `matchId` from upload `201` responses (or your stored ids).

### Success — `200`

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

| Field         | Notes                                                                              |
| ------------- | ---------------------------------------------------------------------------------- |
| `status`      | e.g. `COMPLETED`, `WAITING_FOR_APPROVAL`, …                                        |
| `externalId`  | From WOS report when present, else `null`                                          |
| `players`     | Only seats that have a stats row (full combat fields always present on each entry) |
| Non-completed | Stats still returned when present (useful while awaiting mod approval)             |

**`404`** if the match is missing or belongs to another league.

---

## Errors

All error bodies:

```json
{ "error": "English message" }
```

| HTTP  | When                                                                                         |
| ----- | -------------------------------------------------------------------------------------------- |
| `401` | Missing or invalid Bearer token                                                              |
| `403` | League is not WOS                                                                            |
| `400` | Bad query (`scope`, `games`, dates, `from`/`to` on non-`range`, etc.); bad hero key encoding |
| `404` | Unknown path; non-GET on these paths; unknown hero; match not in league                      |
| `500` | Unexpected server error                                                                      |

Example `400` messages:

- `Invalid scope: must be one of all, last, range, both`
- `from is required when scope is range`
- `Invalid hero key encoding.`

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

**Hero stats by name (default `scope=both`)**

```bash
HERO='Raiden Ei'
curl -sS "$BASE_URL/v1/heroes/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$HERO")/stats" \
  -H "Authorization: Bearer $TOKEN"
```

**Hero stats by object id — last 50 games, no top players**

```bash
curl -sS "$BASE_URL/v1/heroes/123/stats?scope=last&games=50&topPlayers=0" \
  -H "Authorization: Bearer $TOKEN"
```

**Hero stats for a calendar range**

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

## Suggested client flow

1. Obtain league token from staff; store as a secret.
2. Call `GET /v1/heroes` once (or cache) and prefer `objectId` keys.
3. For leaderboards / hero pages: `GET /v1/heroes/{id}/stats?scope=both` (or `last` / `range` as needed).
4. After a successful match upload (`201` + `matchId`), call `GET /v1/matches/{matchId}/stats` when you need the combat breakdown (works even while `WAITING_FOR_APPROVAL` if stats rows exist).
5. Treat `401`/`403` as config problems; `404` on hero as “no data yet”.

---

## Out of scope (v1)

- Player-centric routes (`/v1/players/...`)
- Item meta board (Discord `/items` equivalent)
- UDBR / non-WOS leagues
- Unauthenticated / public access
- Completing or moderating matches over HTTP

---

## Support

- League / Discord config: server staff
- Contract questions / bugs: repo `chmieleski/trueskill-bot`
- Design: `docs/superpowers/specs/2026-09-27-api-wos-hero-stats-design.md`
- Match upload guide: `docs/api/wos-match-upload.md`
- Future HTTPS: GitHub issue [#163](https://github.com/chmieleski/trueskill-bot/issues/163)
