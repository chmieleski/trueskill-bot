# Match History — Design

**Date:** 2026-08-16  
**Status:** Approved for implementation planning  
**Scope:** `general` (league-scoped completed matches; not game-specific)

## Goal

Players can browse **their completed match history** (newest first, paginated) and open a **read-only detail** for one match by id. Looking up another Discord user’s history is supported via an optional `user` option.

## Non-goals (v1)

- Nick-based history lookup (Discord `user` only)
- Pending / in-progress / cancelled matches in the list
- Select menus or jump-to-original lobby message links
- Inventing ki **deltas** when only post-match snapshots exist
- Cross-league history in one embed (always one resolved `leagueId`)
- Changing manage flows (`complete` / `cancel` / `quitters` / correction)

## Locked decisions

| Topic                      | Choice                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Whose history              | Invoker by default; optional `@user`                                                                              |
| Status filter              | **`COMPLETED` only**                                                                                              |
| List row content           | Summary: match id, date, W/L, team, hero (`—` if none); **`Q`** marker when `isQuitter`                           |
| Command shape              | **`/match history`** + **`/match show`**                                                                          |
| Pagination                 | **10 per page**, slash `page` option + Prev/Next buttons, **invoker-only**                                        |
| League                     | Resolved via existing league helpers (same as `/rank` / `/leaderboard`)                                           |
| Detail embed               | Reuse **`buildMatchCompletedEmbed`**                                                                              |
| Ki on show                 | **Omit** `ratingPreview` — `MatchRatingSnapshot` stores **pre-match** μ/σ for corrections, not post-match display |
| Wrong guild/league on show | Treat as **not found** (do not leak other tenants)                                                                |
| Language                   | English user-facing strings                                                                                       |

## Approach

**A with a light B split:** extend `/match` with `history` / `show`; put list query, history embed, and page-button helpers in `src/services/match/match-history.ts`. Commands stay thin Discord adapters. Reuse `getMatchById` and `buildMatchCompletedEmbed` for detail.

## Architecture

```text
/match history|show
  → commands/match/match.ts (adapter)
  → services/match/match-history.ts (list + history embed + pagination ids)
  → getMatchById + buildMatchCompletedEmbed (show)
  → discord/interactions/* (history page buttons, mirror leaderboard)
```

### Modules

| Path                                  | Responsibility                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/commands/match/match.ts`         | Subcommand defs + execute branches for `history` / `show`                                                                             |
| `src/services/match/match-history.ts` | Load page, format rows, build embed + button customIds/parse; show loader (tenancy, snapshot→preview without deltas, completed embed) |
| `src/services/match/index.ts`         | Re-exports                                                                                                                            |
| `src/discord/interactions/`           | History page button handler (invoker check + edit reply)                                                                              |

## Commands

### `/match history`

| Option   | Required | Notes                                                  |
| -------- | -------- | ------------------------------------------------------ |
| `user`   | no       | Discord user; default invoker                          |
| `page`   | no       | Integer ≥ 1; default 1; clamp to last page if too high |
| `league` | no       | Existing `withSubcommandLeagueOption`                  |

**Behavior**

1. Resolve `leagueId`.
2. Resolve target Discord id → linked `Player` (same linking expectation as `/rank` user lookup; no nick option).
3. Load completed matches for that `playerId` in the league, ordered by `completedAt` desc (fallback `createdAt` if null).
4. Reply with a public embed + optional Prev/Next components.

**Empty state:** still post the embed (“No completed matches yet.”); no page buttons.

### `/match show`

| Option     | Required | Notes                                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------------------------ |
| `match_id` | yes      | Cuid string                                                                                      |
| `league`   | no       | If provided, match must equal that league; otherwise match must belong to a league in this guild |

**Behavior**

1. `getMatchById`.
2. Missing id or wrong guild/league → “Match not found.” Match found in this guild/league but not `COMPLETED` → “This match is not completed.”
3. Map roster; determine winning team from player `result` values.
4. Reply with `buildMatchCompletedEmbed` **without** `ratingPreview` (snapshots are pre-match only).

## Data

### List query (conceptual)

- `Match.status = COMPLETED`
- `Match.leagueId = :leagueId`
- Exists `MatchPlayer` with `playerId = :playerId`
- Order: `completedAt DESC`
- Page size: **10** (`skip` / `take`)

Existing indexes (`MatchPlayer.playerId`, `Match(leagueId, completedAt)`) are sufficient for v1; no schema migration.

### History row fields (from the target’s `MatchPlayer`)

- `match.id`
- `match.completedAt` (display date)
- `result` → `W` / `L` (completed matches should have a result)
- `team` → team display name via existing helpers / profile
- `heroId` → hero name when catalog/profile provides it; else `—`
- `isQuitter` → append ` Q` (or equivalent clear marker)

### Show + ratings display

- Show roster + winner only via `buildMatchCompletedEmbed`.
- Do **not** attach live ratings or invent deltas from `MatchRatingSnapshot` (those rows are pre-apply snapshots for match correction).

## Pagination buttons

Mirror leaderboard:

- Custom id encodes: feature prefix, invoker Discord id, target `playerId`, league id, direction, current page.
- Non-invoker clicks → ephemeral deny.
- On success → reload page and `editReply` / update message embed + components.

## Errors

| Case                          | Response                               |
| ----------------------------- | -------------------------------------- |
| Not in a guild                | Ephemeral: command is server-only      |
| League resolve failure        | Existing league helper message         |
| Target not linked / no player | Clear English: not linked / no profile |
| No matches                    | Empty history embed (not an error)     |
| Page too high                 | Clamp to last page                     |
| Show: unknown / wrong tenant  | Match not found                        |
| Show: not completed           | This match is not completed            |
| Button: wrong user            | Ephemeral deny                         |

## Testing

- Unit: pagination clamp, row formatting (W/L, Q, missing hero), customId build/parse
- Unit: show tenancy (other league → not found), non-completed reject
- Service/command tests in the style of existing match / leaderboard tests (no live Discord)

## Docs / public cheat sheet

After implementation, add brief lines to the Discord public cheat sheet for `/match history` and `/match show` (English).

## Out of scope follow-ups

1. Nick lookup on history
2. Deep link to original Discord lobby message
3. Include cancelled matches with a status column
4. Historical ki deltas if we later persist post-match (or before+after) display snapshots
