# Match List (league feed) — Design

**Date:** 2026-08-19  
**Status:** Approved for implementation planning  
**Scope:** `general` (league-scoped completed matches; not game-specific)

## Goal

Anyone in a guild can browse **all completed matches for the resolved league** (newest first, paginated), then open a **read-only detail** with the existing `/match show` command. This is a league feed, not a player history.

## Non-goals (v1)

- Changing `/match history` (stays player-scoped: self or optional `@user`)
- Rosters, heroes, ki, quitters, or W/L on list rows
- In-progress, pending, cancelled, or voided matches
- Extra filters (player, date range, host)
- Nick lookup, select menus, or jump-to-original lobby message
- Cross-league list in one embed (always one resolved `leagueId`)
- Schema / env / SSM changes
- Allowing `/match list` in a lobby channel

## Locked decisions

| Topic | Choice |
|-------|--------|
| Command | **`/match list`** (new subcommand) |
| Who can run it | Anyone in the server; **public** reply; **no `/link` required** |
| Status filter | **`COMPLETED` only** |
| Row content | Date, winner (`teamDisplayName`), format `4v6` (team-1 vs team-2 human counts), copyable match id |
| Detail | Existing **`/match show`** (unchanged) |
| Pagination | **10 per page**, slash `page` option + Prev/Next, **invoker-only** |
| League | Existing `withSubcommandLeagueOption` / resolve helpers |
| Lobby channel | **Denied** (default-deny; `list` is not on the in-progress allowlist) |
| Button `customId` | Discord max **100**; compact UUID league ids; no player id on the button |
| Language | English user-facing strings |

## Approach

Dedicated list module. Thin `/match list` adapter in `match.ts`. Query, compact embed, and `ml:` pagination ids live in `src/services/match/match-list.ts`. Player history stays in `match-history.ts` (hero / W/L / ki / rank-reset). Reuse `winningTeamFromPlayers` and `clampMatchHistoryPage` only.

## Architecture

```text
/match list
  → commands/match/match.ts (adapter: league, page, public reply)
  → services/match/match-list.ts (COMPLETED query, compact embed, ml: button ids)
  → discord/interactions/match-list-interactions.ts (invoker-only Prev/Next)
  → /match show (unchanged; detail from copied id)
```

`/match history` is untouched.

### Modules

| Path | Responsibility |
|------|----------------|
| `src/commands/match/match.ts` | `list` subcommand + public execute branch |
| `src/services/match/match-list.ts` | Load page, format rows, embed, customId build/parse (compact UUID) |
| `src/services/match/match-list.test.ts` | Format, clamp, customId parse/length |
| `src/services/match/index.ts` | Re-exports |
| `src/discord/interactions/match-list-interactions.ts` | History-style button handler (`ml:p:` prefix) |
| `src/events/interaction-create.ts` | Route list page buttons |
| `src/services/league/league-lobby-channel.test.ts` | Assert `list` is denied in lobby channels |
| `docs/discord/public/07-cheat-sheet.md` | One English cheat line |

Do **not** import player-history query, ki preview, or rank-reset into the list module. Extract UUID compact/expand into `src/services/match/compact-custom-id.ts` and import it from both `match-history.ts` and `match-list.ts`.

## Commands

### `/match list`

| Option | Required | Notes |
|--------|----------|-------|
| `page` | no | Integer ≥ 1; default 1; clamp to last page if too high |
| `league` | no | Existing `withSubcommandLeagueOption` |

**Behavior**

1. Resolve `leagueId` (same helpers as `/rank` / `/match history`).
2. Load completed matches for that league, newest first.
3. Reply public with embed + optional Prev/Next.

No `user` option. Always `deferReply()` public (like `/match show`). There is no self-unlinked ephemeral path because the command does not need a linked player.

**Empty state:** still post the embed (“No completed matches yet.”); no page buttons.

### `/match show`

Unchanged. List rows exist so people can copy an id into show.

## Data

### List query (conceptual)

- `Match.status = COMPLETED`
- `Match.leagueId = :leagueId`
- Order: `completedAt DESC` (`nulls: last`), then `createdAt DESC`
- Page size: **10** (`skip` / `take`)
- Include `players` only to compute winner and team sizes

Existing `Match(leagueId, completedAt)` index is enough; no migration.

### Row fields

| Field | Source |
|-------|--------|
| Winner | `winningTeamFromPlayers` → `teamDisplayName(team, profile)` |
| Format | Count `MatchPlayer` rows with `team === 1` vs `team === 2` → `` `${a}v${b}` `` (e.g. `4v6`). **Team 1 vs team 2**, not winner-first. Empty slots are not rows. Ignore any other `team` value. |
| Date | `completedAt ?? createdAt`, Discord `<t:unix:D>` |
| Id | `match.id` in backticks |

Completed matches are expected to have WIN/LOSS rows. Winner uses existing `winningTeamFromPlayers` (team 2 if no team-1 WIN). Do not add a new winner algorithm.

### Embed

- Author: league name from `getLeagueById`
- Title: `Match list`
- Description: `Page **X** of **Y** · N matches`
- One embed field per match: name = winner + format; value = date + copyable id
- Footer: copy id → `/match show` (same idea as history)
- Empty: one field `_No completed matches yet._`

## Pagination buttons

Discord **`customId` max 100 characters**.

```text
ml:p:{invokerId}:{compactLeagueId}:{p|n}:{page}
```

| Piece | Budget |
|-------|--------|
| `ml:p:` | 5 |
| invoker snowflake | ~17–19 |
| compact league UUID | 32 (strip hyphens; cuid ~25) |
| `p`/`n` + page | ~3–8 |
| colons | 3 |
| **typical total** | **~60–70 / 100** |

- Compact UUID via shared `compactUuidForCustomId` / `expandUuidFromCustomId` (`36` → `32`; restore hyphens on parse). History uses the same helpers.
- Prefix `ml:p:` must not collide with history `mh:p:`.
- No player id and no match id on the button.
- Labels: `Previous` / `Next` (80-char label limit is not a concern).
- Hidden when `totalPages <= 1`.
- Non-invoker click → ephemeral deny (same sentence as history).
- Success → reload page and `editReply` embed + components.

## Errors

| Case | Response |
|------|----------|
| Not in a guild | Ephemeral: command is server-only |
| League resolve failure | Existing league helper message |
| No completed matches | Empty list embed (not an error) |
| Page too high | Clamp to last page |
| Lobby channel | Existing deny (`list` is not on the in-progress allowlist) |
| Button: wrong user | Ephemeral: only the person who ran the command can change pages |
| Button: stale/unparseable id | Ignore (same as history) |

Wrong-tenant matches never appear: the query uses the resolved `leagueId`, which is already guild-scoped. `/match show` keeps today’s not-found / not-completed messages.

## Testing

Unit tests (no live Discord), same style as `match-history.test.ts`:

- Format: winner label + `4v6` from team-1 vs team-2 counts (including unbalanced)
- Page clamp (too high → last page; invalid → 1)
- customId build/parse, including compact UUID league ids
- customId length **≤ 100** with a 19-digit snowflake + compact UUID + a large page number

Allowlist: `isLobbyChannelAllowedCommand('match', 'list')` is **false**.

Command: `/match` data includes a `list` subcommand (`match.test.ts`).

Public cheat sheet: one English line for `/match list`.

## Docs / public cheat sheet

Add under **Match (anyone)**:

```text
• `/match list` — completed matches in this league (optional page)
```

Keep the existing `/match history` and `/match show` lines.

## Out of scope follow-ups

1. Filters (player, date, host)
2. In-progress or cancelled rows with a status column
3. Mini roster on the row
4. Allowing the feed in lobby channels
