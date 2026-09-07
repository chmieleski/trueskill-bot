# HTTP API — WOS match ingest + mod approval — Design

**Date:** 2026-09-07  
**Status:** Approved for implementation planning  
**Scope:**
- `game:warcraft3_wos` — report parse, roster mapping, winner inference, stats persistence (reuse existing modules)
- `general` — HTTP server in the bot process, league API tokens, `WAITING_FOR_APPROVAL` status, approval channel config, Discord approval UI, approve → ratings / reject → cancel

## Goal

Allow an external automation to submit a finished WOS match by uploading a raw WOS2 bot report. The bot creates a **new** match (no Discord lobby), places it in **`WAITING_FOR_APPROVAL`**, posts it to a configured league channel, and requires a **match mod** to approve (with edits for quitters, griefers, and winner) or reject before ratings apply.

## Non-goals (v1)

- UDBR / other games
- Attaching to an existing Discord `PENDING` / `IN_PROGRESS` match
- Auto-approve or skip mod review
- Separate HTTP microservice / queue between API and Discord
- Multiple API tokens per league
- Public unauthenticated endpoints
- Event (unrated) matches via this API
- Draws

## Decisions (locked)

| Topic | Choice |
| --- | --- |
| Creation model | API creates a brand-new match only (Approach 1) |
| Initial status | `WAITING_FOR_APPROVAL` (never PENDING / IN_PROGRESS) |
| Payload | Raw WOS2 bot report text (`reportText`); server uses `parseWos2BotReport` |
| Player identity | In-game / Battle.net nick; create `Player` rows as needed |
| Game | WOS only (`postMatchStats === wos2_bot_v1`) |
| League targeting | League-scoped API bearer token (no `leagueId` in body) |
| Process | Same Node process as Discord bot |
| Infra | OpenTofu must expose listen port (SG ingress + SSM env + `refresh-env.sh`) |
| Approval channel | New league setting `matchApprovalChannelId` |
| Who may act | Guild `match_mod` role only (no Discord host) |
| Mod actions | Edit quitters · Edit griefers · Set/override winner · Approve · Reject |
| On Approve | Complete + OpenSkill (same rules as `completeMatch`) |
| On Reject | `CANCELLED`, no ratings |
| Winner seed | `inferSuggestedWinner`; stored as editable `approvalWinnerTeam`; must be set before Approve |
| Quitter seed | Prefill `isQuitter` from WOS `left=1` |
| Duplicate report | `409` when WOS `externalId` already used on a non-voided match |
| Token storage | Hash only (e.g. SHA-256); plaintext shown once on create/rotate |

## Lifecycle

```text
POST /v1/matches/wos-report + Bearer token
  → resolve league from token hash
  → parse WOS report → roster + suggested winner + quitters(left)
  → persist Match (WAITING_FOR_APPROVAL) + MatchPlayers + MatchStatsReport
  → post approval embed in matchApprovalChannelId
  → 201 { matchId, status, externalId, suggestedWinner, discordMessageUrl? }

Mod on Discord
  → edit flags / set winner (still WAITING_FOR_APPROVAL)
  → Approve → COMPLETED + ratings (stats already present)
  → Reject  → CANCELLED
```

## HTTP API

### Endpoint

`POST /v1/matches/wos-report`

### Auth

`Authorization: Bearer <league_api_token>`

Token resolves to exactly one active league that is WOS-capable. Invalid/missing → `401`.

### Body

```json
{ "reportText": "<raw WOS2 bot export text>" }
```

### Success — `201`

```json
{
  "matchId": "…",
  "status": "WAITING_FOR_APPROVAL",
  "externalId": "…",
  "suggestedWinner": 1,
  "discordMessageUrl": "https://discord.com/channels/…"
}
```

`suggestedWinner` may be `null` when inference is inconclusive.  
`discordMessageUrl` omitted or null if Discord post failed after DB commit (see Failure modes).

### Errors

| Code | When |
| --- | --- |
| `401` | Missing/invalid token |
| `400` | Empty/invalid JSON, parse error, roster validation, league not WOS, approval channel unset |
| `409` | WOS `externalId` already stored on another non-voided match |
| `5xx` | Unexpected server errors only; Discord post failure after a successful DB commit is **not** a failed ingest — see Failure modes |

### Process env

| Var | Purpose |
| --- | --- |
| `API_ENABLED` | When false/unset, HTTP server does not listen (safe default) |
| `API_PORT` | Listen port (e.g. `8787`) |
| `API_BIND` | Bind address (default `0.0.0.0`; production exposure controlled by security-group CIDR) |

Document in `src/config/env.ts`, `.env.example`, `.cursor/rules/scripts-and-env.mdc`, SSM, `deploy/aws/refresh-env.sh`, and OpenTofu (`variables.tf`, `ssm.tf`, SG ingress, `terraform.tfvars.example`).

### Infra (OpenTofu)

- Security group **ingress** for `API_PORT` (CIDR via tfvar; default locked down — not open to the world unless explicitly set)
- SSM parameters for `API_ENABLED` / `API_PORT` (and bind if used)
- `refresh-env.sh` writes those keys into host `.env`
- No change to “bot is Discord-only with zero inbound ports” without this feature’s tfvars

## League config

| Setting | Notes |
| --- | --- |
| `matchApprovalChannelId` | Required for successful ingest |
| API token create / rotate / revoke | Via `/league_config` (Manage Guild / existing league admin pattern). Plaintext shown once; store hash + timestamp |

## Discord approval UX

**Channel:** league `matchApprovalChannelId`.

**Auth:** guild `matchModRoleId` only (reuse `canManageMatch` mod path; API matches have no human host — treat host check as N/A / bot sentinel).

**Embed:** teams/roster (nicks), suggested or selected winner, quitters/griefers, report `externalId`, match id.

**Buttons:** Edit quitters · Edit griefers · Set winner · Approve · Reject.

**Approve rules:**
- Winner must be set (`approvalWinnerTeam` or equivalent)
- Both teams have ≥1 non-quitter
- WOS stats already on match → satisfy existing post-match stats gate
- Transition `WAITING_FOR_APPROVAL` → `COMPLETED` with same rating transaction as today’s complete path

**Reject:** `CANCELLED`; embed shows actor; no ratings.

**After terminal state:** remove action buttons; refresh embed like completed/cancelled matches today.

### Match Discord fields

- `hostDiscordId` — bot application user id (or documented sentinel)
- `discordChannelId` / `discordMessageId` — approval channel message (enables refresh)

## Architecture

```text
HTTP route (src/api/)
  → authenticateLeagueApiToken
  → ingestWosReportForApproval()
       → parseWos2BotReport / lobbyPlayersFromWos2Report / inferSuggestedWinner
       → create Match WAITING_FOR_APPROVAL + players (quitters from left)
       → persistWos2MatchStats
       → post approval embed (Discord client)

Buttons
  → assert match_mod
  → match-approval use-cases
       setQuitters / setGriefers / setApprovalWinner
       approveWaitingMatch → completeMatch-compatible transaction
       rejectWaitingMatch → CANCELLED
  → refresh approval message
```

### Modules

| Module | Scope | Responsibility |
| --- | --- | --- |
| `src/api/*` | `general` | HTTP listen, auth middleware, route |
| `ingestWosReportForApproval` | `general` + WOS calls | Ingest orchestration |
| `match-approval.ts` | `general` | Edit / approve / reject use-cases |
| Approval interaction handlers | `general` | Thin Discord adapters |
| Existing WOS parse/roster/winner/stats | `game:warcraft3_wos` / match services | Reuse; do not fork |
| OpenTofu + env sync | infra | Port, enable flag, SG, SSM |

### Schema

- `MatchStatus.WAITING_FOR_APPROVAL`
- `League.matchApprovalChannelId String?`
- Token: `League.apiTokenHash String?` + `apiTokenCreatedAt DateTime?` **or** small `LeagueApiKey` table (one active row per league in v1)
- `Match.approvalWinnerTeam Int?` — `1` \| `2`, set from suggestion on ingest, editable before approve

No separate `MatchSubmission` table in v1.

### `completeMatch` integration

Extend the in-progress lock (or add `approveWaitingMatch`) so `WAITING_FOR_APPROVAL` can move to `COMPLETED` with the same OpenSkill / quitter / griefer / WOS-stats-required behavior. Do not require a fake `IN_PROGRESS` hop.

## Failure modes

| Case | Behavior |
| --- | --- |
| Approval channel unset | Reject ingest with clear English error |
| Parse / roster error | No match created |
| Unknown / new nick | Create `Player` for `(gameId, username)` as lobby fill does |
| Duplicate `externalId` | `409`; no second match |
| Discord post fails after DB commit | Keep match; log error; response includes `matchId` without usable `discordMessageUrl` (ops/mod recovery; optional retry post later) |
| Approve with no winner / empty team | Reject action with English error; stay waiting |
| Non-mod clicks buttons | Ephemeral deny |

## Testing

- Token auth (valid / invalid / wrong league capability)
- Ingest happy path + parse failure + missing channel + `409` duplicate id
- Quitters prefilled from `left=1`
- Approve / reject transitions and rating side effects (mocked Prisma / rating as existing tests do)
- Button auth: non-mod rejected
- No live Discord or AWS in CI

## Open questions resolved in this doc

All product forks for v1 are locked above. Implementation plan may choose hash algorithm details and exact `/league_config` subcommand names without further product decisions.
