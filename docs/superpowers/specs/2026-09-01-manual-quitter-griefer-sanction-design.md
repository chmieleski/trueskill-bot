# Manual quitter / griefer sanctions — Design

**Date:** 2026-09-01  
**Status:** Approved  
**Scope:** `general` (league-scoped penalties and `/rank` counts; guild-wide quitter/griefer boards aggregate automatically)  
**Related:** [`2026-08-16-quitter-leaderboard-design.md`](./2026-08-16-quitter-leaderboard-design.md), [`2026-08-22-habitual-quitter-flag-design.md`](./2026-08-22-habitual-quitter-flag-design.md), `.cursor/rules/openskill-rating.mdc`, `/match unquit` / `/match ungrief`

## Goal

When a griefer or quitter forces an **RMK** (or otherwise never reaches bot cancel/complete), mods can still record the incident: **+1 quitter or +1 griefer marker** on a player **without a real lobby/match**, with **full rating parity** (same penalties as the normal match flow). Mods can also **remove one marker**, defaulting to the latest mod-added sanction.

In-match griefer/quitter buttons during report/cancel stay available to hosts and regular players; only the new add/remove slash paths are mod-only.

## Non-goals

- Bulk add/remove or arbitrary counts in one command (always ±1 per invocation)
- Reason/note field on sanctions (can add later)
- Changing in-match button permissions or report wizard UX
- Event-match sanctions (IHL leagues only)
- Per-league quitter/griefer boards (guild boards unchanged)
- Showing manual sanctions in `/match history` or `/match list`

## Locked decisions

| Topic                     | Choice                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Penalties on add          | **Full parity (B):** quitter → 3 synthetic OpenSkill losses; griefer → deferred ki tax (25%, max 500 ki)                |
| Remove without `match_id` | **C:** clear latest **manual** sanction only; optional `match_id` targets any finished match via existing clear helpers |
| Implementation            | Synthetic **CANCELLED** `Match` with `isManualSanction = true` and one flagged `MatchPlayer`                            |
| Auth                      | Match mod role only (`assertHasMatchModRole`); host role **not** sufficient                                             |
| Player lookup             | Same as `/rank`: `user` or `nick` in the resolved league’s game; optional `league` option                               |
| Tenancy                   | League-scoped match row (`leagueId`); guild boards pick up counts via existing aggregation                              |
| Archived league           | Reject writes (same as other rating mutations)                                                                          |
| Visibility                | Count everywhere stats matter; **hidden** from match history (incl. `griefers_only`) and match list                     |
| Quitter remove (manual)   | Clear flag **and** restore ratings from snapshots written at add time                                                   |
| Griefer remove (manual)   | `clearMatchGriefers` — clears flag and `grieferKiAccrued`                                                               |
| Remove with `match_id`    | Existing `clearMatchQuitters` / `clearMatchGriefers` behavior (incl. cancelled = flag-only for quitters)                |
| Language                  | English user-facing strings                                                                                             |

## Commands

Extend `/match` with subcommand group **`sanction`**:

### `/match sanction add`

| Option   | Required         | Notes                                        |
| -------- | ---------------- | -------------------------------------------- |
| `type`   | yes              | `quitter` \| `griefer`                       |
| `user`   | one of user/nick | Discord user                                 |
| `nick`   | one of user/nick | In-game nick                                 |
| `league` | no               | Same optional league autocomplete as `/rank` |

Ephemeral reply. Refresh guild quitter + griefer live leaderboards on success.

### `/match sanction remove`

| Option     | Required         | Notes                                                  |
| ---------- | ---------------- | ------------------------------------------------------ |
| `type`     | yes              | `quitter` \| `griefer`                                 |
| `user`     | one of user/nick | Target player                                          |
| `nick`     | one of user/nick | Target player                                          |
| `match_id` | no               | When set, use existing clear helpers on that match     |
| `league`   | no               | Required for player resolution when `match_id` omitted |

Ephemeral reply. Refresh guild quitter + griefer live leaderboards on success.

**Existing commands unchanged:** `/match unquit`, `/match ungrief` (require `match_id`); in-match griefer/quitter UI unchanged.

## Data model

```prisma
model Match {
  // …existing fields…
  isManualSanction Boolean @default(false)

  @@index([leagueId, isManualSanction, createdAt])
}
```

No new tables. Each add creates a new match row.

Manual sanction match shape:

| Field              | Value                     |
| ------------------ | ------------------------- |
| `status`           | `CANCELLED`               |
| `isManualSanction` | `true`                    |
| `leagueId`         | resolved league           |
| `hostDiscordId`    | invoking mod              |
| `discordChannelId` | channel where command ran |
| `completedAt`      | `null`                    |
| `eventId`          | `null`                    |

Single `MatchPlayer`:

| Field                     | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| `slot`                    | `1`                                                                             |
| `team`                    | `1`                                                                             |
| `heroId`                  | `null` when game profile has no slot-bound hero; else slot-bound rules as today |
| `isQuitter` / `isGriefer` | per `type` (mutually exclusive)                                                 |
| `result`                  | `null`                                                                          |

## Add flow

Service: `addManualSanction` in `src/services/match/manual-sanction.ts`.

1. Assert league writable (not archived).
2. Resolve player via `findPlayerForRankLookup` (same rules as `/rank`).
3. In one transaction:
   - Create manual sanction `Match` + `MatchPlayer`.
   - `ensurePlayerRatings` for the player.
   - **Quitter:** `writeMatchRatingSnapshots` → build one-entry roster → `applyQuitterPenalties`.
   - **Griefer:** load live global ki + display stats → `accrueGrieferPenalties` (single griefer entry).
4. Return summary: `matchId`, player username, type, updated quits/griefs (from display stats), griefer ki accrued if applicable.

Multiple RMK incidents → multiple separate manual matches (each +1 count).

## Remove flow

Service: `removeManualSanction` in `src/services/match/manual-sanction.ts`.

### With `match_id`

Delegate to existing helpers (mod auth already checked at command layer):

- `type = quitter` → `clearMatchQuitters(matchId)` (slot omitted → all quitters on match; manual matches have one)
- `type = griefer` → `clearMatchGriefers(matchId)`

Validate the target player appears on that match with the expected flag when resolving by player + optional match_id.

### Without `match_id`

Query latest manual sanction in the league for `(playerId, type)`:

```text
match.leagueId = league
match.isManualSanction = true
match.status = CANCELLED
matchPlayer.playerId = player
matchPlayer.isQuitter = true   (or isGriefer && !isQuitter for griefer)
orderBy match.createdAt desc
take 1
```

If none: `MatchServiceError` — no manual sanction to remove.

- **Griefer:** `clearMatchGriefers(foundMatchId)`.
- **Quitter:** transaction: `restoreMatchRatingSnapshots(leagueId, matchId)` then clear `isQuitter` on the player row (manual-only path; restores synthetic penalty).

## Side effects

After add or remove:

- `refreshGuildQuitterLeaderboard(guildId)` when quitter count affected
- `refreshGuildGrieferLeaderboard(guildId)` when griefer count affected

No lobby Discord message sync (no lobby message on manual sanctions).

## Visibility filters

Exclude `isManualSanction: true` from:

- `loadMatchHistoryPage` — both default and `griefers_only` queries
- Any future match browse that would show cancelled grief rows to players

`/match list` already filters `status: COMPLETED` only; no change required.

Stats that **include** manual sanctions (unchanged query paths):

- `/rank` quits/griefs (`loadMatchDisplayStats`)
- Guild quitter/griefer leaderboards
- Habitual quitter ⚠️ on rosters
- Griefer season tax rollover (`grieferKiAccrued` on manual rows)

## Errors (user-facing)

| Case                           | Message (representative)                                           |
| ------------------------------ | ------------------------------------------------------------------ |
| Not mod / mod role unset       | Existing mod auth messages                                         |
| Guild-only command             | `This command can only be used in a server.`                       |
| League resolve failure         | Existing league resolve copy                                       |
| Archived league                | `That league is archived. Pick an active league.`                  |
| Player not found               | Same as `/rank` lookup failures                                    |
| Remove, no manual row          | `No manual quitter sanction found for **nick**.` / griefer variant |
| Remove, `match_id` wrong flag  | Existing clear helper errors                                       |
| Both `user` and `nick` missing | `Provide a user or nick.`                                          |

## Architecture

```text
/match sanction add|remove  (match.ts — thin adapter)
  → assertHasMatchModRole
  → resolveLeagueIdFromInteraction
  → addManualSanction | removeManualSanction  (manual-sanction.ts)
       → prisma Match + MatchPlayer
       → applyQuitterPenalties | accrueGrieferPenalties  (rating-update.ts)
       → writeMatchRatingSnapshots | restoreMatchRatingSnapshots  (match-correction.ts)
       → clearMatchQuitters | clearMatchGriefers  (match-report.ts, remove + match_id)
  → refreshGuild*Leaderboard
```

## Testing (acceptance)

- Unit: `addManualSanction` quitter — creates CANCELLED manual match, applies snapshots + synthetic penalty, increments quit count in display stats
- Unit: `addManualSanction` griefer — sets `grieferKiAccrued`, increments grief count
- Unit: `removeManualSanction` without `match_id` — removes latest manual row only; does not touch normal match flags
- Unit: `removeManualSanction` quitter manual — restores μ/σ from snapshots
- Unit: `removeManualSanction` with `match_id` — delegates to clear helpers
- Unit: archived league rejected on add
- Unit: `loadMatchHistoryPage` griefers_only excludes manual sanctions
- Command: mod auth enforced; non-mod rejected
- Regression: in-match `setQuitters` / `setGriefers` unchanged

## Open follow-ups (not v1)

- Optional `reason` text on manual sanctions
- `/rank` or staff audit listing of manual sanctions
- Reverse quitter synthetics on `/match unquit` for cancelled non-manual matches
